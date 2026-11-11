# Engine recipes

Per-engine request shape, extraction rules, freshness mapping, and measured status. Everything
under "probe" was run from this machine (consumer IP, HTTP proxy at `127.0.0.1:7897`) on
2026-11-11; the reference implementations that informed the parsing are from
[sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp) (MIT).

A general note that cost real time: **counting results proves nothing.** Bing serves a 200 with
ten perfectly formed `b_algo` rows that are all Microsoft-365 pages; DuckDuckGo and Brave serve
200/429 shells. The engine must (a) match wall markers, (b) check that rows mention the query,
and (c) never translate "no rows" into "no results" silently.

---

## yahoojp — Yahoo! JAPAN (works)

```js
url = 'https://search.yahoo.co.jp/search?p=' + enc(q) + '&ei=UTF-8' + (fresh ? '&vd=' + {day:'d',week:'w',month:'m1',year:'y'}[fresh] : '')
headers: { accept-language: 'en-US,en;q=0.9' }
```

- Cards: `<div class="sw-Card Algo">`. News/image/AI cards are sibling `sw-Card` modifiers and
  are skipped by construction (the literal `Algo` class token).
- Title: inside `<h3>` of `div.sw-Card__title`; the anchor text is `site › breadcrumb › title`,
  so reading the anchor yields breadcrumb noise.
- URL: the anchor href is already absolute — no unwrapping.
- Snippet: `p.sw-Card__summary`.
- `vd=m` is **not** a valid token and silently returns the *unfiltered* ranking; month is `m1`.
- EEA/UK answers a region-notice page (`og:url` contains `privacy.yahoo.co.jp/areacheck`) →
  handled by the consent gate, not by an empty result.

Probe: 200, 9 cards, `doc.rust-lang.org/book/ch04-00…` + reddit thread, real snippets, ~1.4 s.

## so360 — 360 Search (works, CAPTCHA-prone)

```js
url = 'https://www.so.com/s?q=' + enc(q) + '&rn=' + clamp(n,10,50) + (fresh ? '&adv_t=' + {day:'d',week:'w',month:'m',year:'y'}[fresh] : '')
```

- Items: `<li class="res-list">` (≈7 per page, not 10).
- URL: `data-mdurl` on the title anchor; the href is a `www.so.com/link?m=…` wrapper.
- Title: `<h3>` block. Snippet: `p.res-desc` or `div.res-comm-con`; the leading `span.gray`
  holds `2026年1月14日`, which is stripped from the snippet and parsed as `publishedAt`.
- `data-mdurl` also carries 360's own chrome (`hao.360.com`, `tv.360kan.com`, `www.bing.com`) —
  filtered, or the model cites a portal page.

Probe: 200, 7 items, 14 `data-mdurl` (10 after the host filter), ~0.6 s. Under load the same
URL answers `安全验证` — treated as a CAPTCHA gate and benched.

## sogou — Sogou (works, needs a cookie pre-step)

```js
GET https://www.sogou.com/            // mint the session cookie (process-lifetime jar)
url = 'https://www.sogou.com/web?query=' + enc(q)
headers: { cookie, referer: 'https://www.sogou.com/' }
```

- Items: `<div class="vrwrap">` (skip `vrwrap middle-better-hintBox`).
- URL: `div.r-sech.ext_query[data-url]` inside the same block. The `<h3>` anchor is a
  `/link?url=hedJja…` token that 302s back to Sogou's *homepage* even with cookies and a
  referer — following it is a dead end.
- The `citeLinkClass` spans are `[site name, truncated display url, date]`; the second is
  display-only (`https://www.jb51.net/a...`) and must never become `url`.
- Without the pre-step cookie the first query can come back with no items.

Probe: 200, 10 result blocks, 10 external `data-url` targets, ~1.1 s. Anti-bot page
(`anticaptcha`) is a gate.

## wikipedia — MediaWiki API (works)

```js
url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=${n}&srprop=snippet%7Ctimestamp&format=json&utf8=1`
lang = /CJK/ in q ? 'zh' : 'en'
```

- JSON, no HTML parsing. `hit.snippet` carries `<span class="searchmatch">` markup → strip tags.
- Article URL is reconstructed from the title: `/wiki/` + `encodeURIComponent(title.replaceAll(' ','_'))`.
- Never benched: it answers 200 JSON reliably. It returns rows for encyclopedic queries only,
  which is the right behaviour for a supplementary engine.

## duckduckgo — DuckDuckGo HTML (works, referer-gated)

```js
url = 'https://html.duckduckgo.com/html/?q=' + enc(q) + (fresh ? '&df=' + {day:'d',week:'w',month:'m',year:'y'}[fresh] : '')
headers: { referer: 'https://duckduckgo.com/' }
```

- **The referer is the whole engine.** Without it the endpoint answers `202` with
  `anomaly-modal` (the well-known "DDG is blocked" result); with it, the same URL is a normal
  200 page. `lite.duckduckgo.com` stays blocked even with the referer, so only `html.` is used.
- Blocks: `<h2 class="result__title">`; anchor `a.result__a`; snippet `a.result__snippet`.
- URL: `//duckduckgo.com/l/?uddg=<percent-encoded>` — the query parser decodes that value *once*,
  so it must not be decoded again or `…/wiki/C%2B%2B` becomes a URL that 404s.

Probe: 200, 33 KB, 10 result blocks, real `doc.rust-lang.org` / `w3schools` / `rust-book`
targets, ~1.0 s.

## bing — Bing (decoy from this egress)

```js
// HTML route
url = 'https://www4.bing.com/search?q=' + enc(q) + '&form=QBRE' + (fresh ? '&filters=' + enc({day:'ex1:"ez1"',…}[fresh]) : '')
// RSS route (fallback, structured)
url = 'https://www4.bing.com/search?q=' + enc(q) + '&format=rss'
```

- `form=QBRE` is the full layout; `form=QBLH` has no `.b_algo` at all. **Never send `count=`** —
  no browser does, and a count-bearing request gets the decoy page.
- HTML items: `<li class="b_algo">`, title `<h2><a href>`, snippet `p.b_lineclamp*`/`b_paractl`,
  date `span.news_dt`. Links are `bing.com/ck/a?…&u=a1<base64url>` → decode.
- RSS items: `<title>/<link>/<description>/<pubDate>`, 10 rows, RFC-2822 (localized: the feed
  behind a Chinese egress writes `周二, 10 11月 2026 09:00:00 GMT`, so date parsing is
  locale-tolerant and lives in `src/util/dates.mjs`).

Probe: HTML 200 / 10 `b_algo` / **every decoded target a Microsoft property**, with and without
a cookie jar and `form=QBRE`; RSS 200 / 10 items but off-topic rows too. The **coherence gate**
is what keeps this engine from polluting results — its bucket scores 0.0 and is dropped. Kept in
the codebase because the decoy is a property of the egress IP, not of the recipe.

## brave — Brave Search (429 here)

```js
url = 'https://search.brave.com/search?q=' + enc(q) + '&source=web' + (fresh ? '&tf=' + {day:'pd',week:'pw',month:'pm',year:'py'}[fresh] : '')
```

- Items: `div.snippet[data-type="web"]`, title `div.title.search-snippet-title`, snippet
  `div.snippet-description` / `snippet-content`.
- Anti-bot is a proof-of-work challenge: a plain HTTP client cannot pass it. Probe: 429, 76 KB
  "Too many"/captcha interstitial. The gate reports it as a non-result so the breaker benches it.

## baidu — Baidu (CAPTCHA most days)

```js
url = 'https://www.baidu.com/s?wd=' + enc(q) + '&rn=' + clamp(n,10,50)
```

- Containers: `div.result(?:-op)? c-container`; the destination is in the container's `mu=`
  attribute — today's `<h3>` anchor has **no href at all** (JS click handler).
- Filter `*.baidu.com` (`nourl.ubs.baidu.com`, `*.recommend_list.baidu.com` are ad slots).
- No freshness parameter that works without session-bound timestamps; filter client-side.
- Probe: one run 200 with 10 containers / 11 `mu` / 8 external; the next run
  `百度安全验证`. Off by default.

## Considered and rejected

| source | why not |
|---|---|
| DuckDuckGo Lite | 202 + `anomaly-modal` even with a referer; only the `html.` endpoint is usable (see above). Its Instant-Answer API is not a web index (`Results: []`) |
| Google News RSS | works, but every `<link>` is an opaque `news.google.com/rss/articles/CBM…` blob — uncitable and undedupable without replaying Google's RPC |
| Public SearXNG instances | every probed instance refuses `format=json` (429, Anubis gate, captcha, HTML-only). Support a *self-hosted* instance if you have one |
| Mojeek / Startpage / yahoo.com | TLS failure / captcha / HTTP 500 |
| `r.jina.ai` reader | 401 `AuthenticationRequiredError … bad IP reputation` — no longer keyless |
| anysearch anon API | reachable (5 results) but off-topic for technical queries and unoperated by operators; the coherence gate would drop it anyway |
| MCP bridge to free-search-mcp | would register MCP tools into `ctx.tools` — a new tool surface, which is exactly what this plugin must not add |

## Fetch / extraction

`src/fetch/reader.mjs`, in three passes:

1. drop `script/style/noscript/template/svg/iframe/form/nav/aside/footer/header/button/select/dialog`;
2. drop chrome **containers** matched on `id`/`class` tokens (`sidebar`, `toc`, `related`,
   `breadcrumbs`, `prev-next`, `mdbook-help`, …) with depth-balanced removal — a non-greedy
   `</div>` cuts an `mdbook` page at its first nested block;
3. pick the region with the most paragraph text among `article` → `main` → `[role=main]` →
   `#content` → `.content`-like classes → `body`, then convert to Markdown (headings, lists,
   fenced code, quotes, tables, links) and trim leading/trailing link-only nav lines.

The reference implementation uses trafilatura; `favor_precision` has no drop-in here, so the
region score + nav trim is the pragmatic replacement. Measured on an MDN guide page: 20,470
characters of article, opening at the `# Regular expressions` heading with no previous/next rail.
