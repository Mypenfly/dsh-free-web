# s001 — keyless SERP engines: copy-pasteable recipes

- agent: sub-s001 · target: Node 22 global `fetch`, regex-only HTML parsing, no DOM lib
- source snapshot: `sweetcornna/free-search-mcp@2c7fee9` (2026-10-31), paths under `src/search_mcp/`
- probes: 2026-11-11 on this machine (`curl 8.23`); response bodies kept in `.probe/t_*`
- **legend** `[V]` verified by my probe today · `[S]` read from source, unverified · `[B]` blocked today

| engine | status | one-line evidence |
|---|---|---|
| yahoojp | **[V] works** | 9 `sw-Card Algo` cards, direct `doc.rust-lang.org` + reddit URLs |
| baidu | **[V] works** | 10 containers, URLs live in `mu=`; `h3 a` has no `href` at all |
| so360 | **[V] works** | 7 `li.res-list`, real URL in `data-mdurl`, `href` is a `/link?m=` wrapper |
| sogou | **[V] works** | no upstream engine exists; recipe is mine, `data-url` carries the URL |
| wikipedia api | **[V] works** | 200 JSON, 5 hits |
| googlenews rss | **[V] works** | 200, 34 `<item>`, links are opaque `CBM…` blobs |
| anysearch | **[V] reachable, off-topic** | 200 + 5 results, all metal-corrosion pages for a Rust query |
| duckduckgo | **[B]** | `html.` and `lite.` both **202 + `anomaly-modal`** |
| bing | **[B]** | 200 + 10 `b_algo`, **all decoy** (Microsoft 365), with or without cookiejar |
| brave | **[B]** | **429** "Too many…"/captcha — IP reputation |
| searx | **[B]** | no public instance answers `format=json` today |
| mojeek / startpage / yahoo.com | **[B]** | TLS handshake failure / captcha / 500 |

---

## 0. Shared plumbing

```js
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SERP_HEADERS = {
  'user-agent': UA, 'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'upgrade-insecure-requests': '1', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1', 'sec-fetch-dest': 'document',
};
```

Upstream uses `curl_cffi` `impersonate="chrome131"` (`httpfetch.IMPERSONATE`) — a real JA3/JA4 **TLS + HTTP/2 fingerprint**, not just a UA string. Node `fetch` cannot imitate it, so assume every `[S]` recipe may need a proxy or a browser render.

```js
// Envelope: base.py `_http_get`; _MAX_ATTEMPTS=2, _RETRYABLE_STATUSES, _RETRY_AFTER_CAP=3s
async function serpGet(url, { timeout = 15000, cookie, referer } = {}) {
  const h = { ...SERP_HEADERS, ...(cookie && { cookie }), ...(referer && { referer }) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout); // request_timeout 15s
    try {
      const r = await fetch(url, { headers: h, redirect: 'follow', signal: ac.signal });
      const body = await r.text();
      if (attempt === 0 && [429, 500, 502, 503, 504].includes(r.status)) {
        const ra = parseFloat(r.headers.get('retry-after') ?? '');
        if (ra > 3) throw new Error(`http ${r.status}`);        // server window > cap: fail now
        await sleep(Number.isFinite(ra) ? ra * 1000 : 600);
        continue;
      }
      if (!r.ok) throw new Error(`http ${r.status}`);
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw e;                    // timeouts are NEVER retried
      if (attempt === 1) throw e;
      await sleep(400 + Math.random() * 400);                  // 0.4–0.8s jitter
    } finally { clearTimeout(t); }
  }
}
```

**Gate detection** (`base.py::_GATE_MARKERS`; lowercase substring test, first reason wins) — return the reason so an empty result is never a silent empty:

```js
const GATES = [
  ['captcha', ['/sorry/index', 'unusual traffic', '/recaptcha/', 'g-recaptcha', 'h-captcha', 'captcha-delivery',
    'px-captcha', 'are you a robot', 'verify you are a human', 'anomaly-modal', 'made by a human',
    'captcha-wrap', 'altcha', 'verification required', 'complete the challenge']],
  ['javascript', ['if you are not redirected', 'please click here if you are not', 'enable javascript to continue', 'javascript is required']],
  ['consent', ['consent.google.com', 'consent.youtube.com', 'before you continue', 'consent.bing.com']],
  ['login', ['请登录', '登录知乎', 'signflow', 'sign in to continue', 'you must log in', 'please log in to continue']],
];
const detectGate = (html) => { const low = html.toLowerCase();
  for (const [reason, marks] of GATES) if (marks.some(m => low.includes(m))) return reason; return null; };
```

**Decoy detection** (`coherence.py`) — a decoy SERP has perfect markup and off-topic results, so counting results proves nothing. Score = share of rows whose `title+snippet+url` mentions a query term **beyond the first token**; needs ≥4 rows and ≥2 such terms, else "cannot tell" (treat as healthy). `< 0.3` ⇒ decoy, drop the bucket. Terms: ASCII tokens with `length > 3`; CJK runs become char-bigrams (`模型架构`→`模型`,`型架`,`架构`).

```js
const coherence = (query, rows) => {
  if (rows.length < 4) return null;
  const rest = [];
  for (const tk of query.split(/\s+/).slice(1)) {
    const cjk = [...tk].filter(c => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7a3]/.test(c));
    if (cjk.length >= 2) for (let i = 0; i < cjk.length - 1; i++) rest.push(cjk[i] + cjk[i + 1]);
    else if (cjk.length === 1 || tk.length > 3) rest.push(tk.toLowerCase());
  }
  if (rest.length < 2) return null;
  return rows.filter(r => rest.some(t => `${r.title} ${r.snippet} ${r.url}`.toLowerCase().includes(t))).length / rows.length;
};
```

**Date hint** (`base.py::extract_date_hint`) — snippet dates are *unconfident*: label/rank with them, never drop a result on them. Absolute: `Apr 28, 2026`, `2026-10-01`, `12/01/2024`, `2026/10/1`, `2026年10月1日`. Relative: `3 days ago`, `5日前`, `3天前`, `3주 전`. Reject `year < 1990` and `date > today + 1d`.

```js
const ABS = [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?\b/,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
  /(?<![A-Za-z\d.])(\d{4})(?:\/(\d{1,2})\/(\d{1,2})(?![\d/])|\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日)/];
const REL = /\b(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago\b/i;
const REL_CJK = /(?<![\s·・,，、\-])(\d{1,3})\s*(分钟|分|時間|小时|日|天|週間|周|週|か月|个月|年|분|시간|일|주|개월|년)\s*(?:前|전)(?![\s·・,，、\-])/;
```

`site:` / `-site:` / `filetype:` are appended to the query text (`augment_query_with_operators`) for every engine — for several it is the **only** way a domain filter reaches the engine.

---

## 1. yahoojp — **[V]** (Google's index, keyless)

```js
const url = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(q)}&ei=UTF-8`
  + (f ? `&vd=${{ day: 'd', week: 'w', month: 'm1', year: 'y' }[f]}` : '');   // GET, no pre-step, no cookies
const opts = { headers: { ...SERP_HEADERS, 'accept-language': 'ja,en-US;q=0.9' } };
// parse: div.sw-Card.Algo — news/image/AI-panel cards are sibling sw-Card modifiers, skipped by construction
const CARD = /<div[^>]*class="[^"]*\bsw-Card\b[^"]*\bAlgo\b[^"]*"[^>]*>/g;
const A    = /<a[^>]*(?:href="(https?:\/\/[^"]+)"[^>]*class="[^"]*sw-Card__titleInner[^"]*"|class="[^"]*sw-Card__titleInner[^"]*"[^>]*href="(https?:\/\/[^"]+)")/;
const H3   = /<h3[^>]*>([\s\S]*?)<\/h3>/;                        // title is in the h3, not the anchor text
const SUM  = /<p[^>]*class="[^"]*sw-Card__summary[^"]*"[^>]*>([\s\S]*?)<\/p>/;
const INTERNAL = ['search.yahoo.co.jp', 'rdsig.yahoo.co.jp', 'ard.yahoo.co.jp'];  // never a result
const GATE_REGION = '<meta property="og:url" content="https://privacy.yahoo.co.jp/areacheck';
```

- **[V]** 200 in 1.4 s, `class="sw-Card Algo"` ×9, direct targets (`doc.rust-lang.org/book/ch04-00-…`, a reddit thread), real snippet text. Note `href` precedes `class` in the anchor, so match either order. `n=` is ignored (~10/page whatever you ask).
- `vd=m` is **not** a valid token and silently returns the *unfiltered* ranking — month must be `m1` [S].
- The title anchor wraps `h3` + favicon + breadcrumb; read the `h3` or you emit `docs.python.org › … Rust`.
- EEA/UK get a notice page since 2022 → parses to `[]`; match the `og:url` meta, not the wording.

## 2. baidu — **[V]**

```js
const url = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${Math.min(Math.max(n, 10), 50)}`;
// GET, no pre-step. No freshness param: gpc=stf=<from>,<to>|stftype=1 needs session-bound unix
// timestamps => post-filter client-side. No safesearch/region param either (account-bound).
const BOX = /<div[^>]*class="result(?:-op)? c-container[^"]*"[^>]*>/g;
const MU  = /\smu="(https?:\/\/[^"]+)"/;                          // THE url carrier
const TTL = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/;           // anchor is usually href-LESS today
const SNP = /class="c-abstract"[^>]*>([\s\S]*?)<\/(?:div|span)>/;  // || [class*=content-right] || [class*=abstract]
```

- **[V]** 200, 860 KB, 10 containers (`result c-container` ×8, `result-op c-container` ×2), 11 `mu=`.
- **`h3` anchors carry no `href` today** (JS click handler) — `mu=` is the only URL. Upstream's `mu || href` order is what keeps it alive; read `href` and you get nothing. 8 of 11 `mu` are external today.
- Drop internal `mu`: 3 of 11 today were ad slots `http://nourl.ubs.baidu.com/61344` and `http://28608.recommend_list.baidu.com`. Filter any `*.baidu.com` host.
- Real samples: `jianshu.com/p/b232f2ed5e0e`, `163.com/dy/article/KBP55RCA…`, `fpcomplete.com/rust/ownership-and-impl-traits`, `cnblogs.com/perfei/p/10372920.html`, `zhihu.com/question/565980366`.

## 3. so360 — **[V]**

```js
const url = 'https://www.so.com/s?q=' + encodeURIComponent(q)
  + `&rn=${Math.min(Math.max(n, 10), 50)}`
  + (f ? `&adv_t=${{ day: 'd', week: 'w', month: 'm', year: 'y' }[f]}` : '')
  + (safe !== 'off' ? '&secure=1' : '');
const ITEM = /<li[^>]*class="res-list"[^>]*>/g;                    // ~7 per page, not 10
const MD   = /data-mdurl="([^"]+)"/;                              // prefer; falls back to <h3> … <a href>
const SNP  = /<(?:p|div)[^>]*class="res-(?:desc|comm-con)"[^>]*>([\s\S]*?)</;
```

- **[V]** 200 in 0.6 s, 7 `li.res-list`, 14 `data-mdurl` (10 survive the internal-host filter), 3 `p.res-desc` + 3 `div.res-comm-con`.
- **Source docstring is stale** ("anchors carry direct target URLs… no unwrapping needed"): every `h3 a` href today is `https://www.so.com/link?m=…`. Keep `data-mdurl` first in the fallback chain.
- `data-mdurl` also carries 360's own chrome — `hao.360.com`, `ranks.hao.360.com`, `tv.360kan.com`, `www.bing.com`. Upstream does **not** filter these; you must (`so.com|360.com|360kan.com`).
- Snippets lead with `2026年1月14日 - …`; feed the date parser, flagged unconfident.

## 4. sogou — **[V], no upstream engine** (recipe derived from the live page)

```js
await fetch('https://www.sogou.com/', { headers: SERP_HEADERS });  // pre-step: cookie jar
const url  = `https://www.sogou.com/web?query=${encodeURIComponent(q)}`;    // paging: &page=N
const opts = { headers: { ...SERP_HEADERS, cookie, referer: 'https://www.sogou.com/web?query=…' } };
const WRAP = /<div[^>]*class="vrwrap"[^>]*>/g;                     // 11/page; skip vrwrap.middle-better-hintBox
const A    = /<h3[^>]*class="vr-title"[^>]*>[\s\S]*?<a[^>]*href="(\/link\?url=[^"]+)"/;
const REAL = /data-url="(https?:\/\/[^"]+)"/;                     // on div.r-sech.ext_query — THE target
const SNP  = /class="(?:fz-mid|cacheresult_summary[^"]*)"[^>]*>([\s\S]*?)<\/(?:div|span)>/;
const CITE = /class="citeLinkClass"[^>]*>([\s\S]*?)<\/a>/;        // spans: [site name, truncated https://…, date]
```

- **[V]** 200, 512 KB, 10 `div.vrwrap` + 1 `vrwrap.middle-better-hintBox`, 11 `data-url`, 7 `.cacheresult_summary`, 19 `/link?url=`.
- **Unwrapping `href` is a dead end**: `GET /link?url=hedJja…` with cookies *and* referer → `302 Location: https://www.sogou.com/`. The blob is session/timestamp bound. Use `data-url`, a hidden sibling `div.r-sech.ext_query` inside the same result block.
- `.citeLinkClass`'s 2nd span is a **truncated display URL** (`https://www.jb51.net/a...`) — never emit it as `url`. The 3rd span is a usable date (`2023-02-16`).

## 5. duckduckgo — **[B]** today

```js
const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  + (f ? `&df=${{ day: 'd', week: 'w', month: 'm', year: 'y' }[f]}` : '')
  + (kp !== null ? `&kp=${kp}` : '')          // strict=1, moderate=-1, off=-2
  + (region ? `&kl=${region}` : '');          // 'us-en' form
const ROW = /<div[^>]*class="result[^"]*"/;   // ONE selector: div.result only. A comma selector matches
                                              // the same div twice (it also has web-result) and doubles
                                              // this engine's weight in the fusion.
const A    = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/;
const SNP  = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
const UNWRAP = /\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)/;   // percent-decode ONCE, not twice
const SKIP = ['result--ad', 'result--sponsored', 'duckduckgo.com/y.js', 'ad_provider='];
```

- **[B]** `html.duckduckgo.com` → **202**, 14 KB, `anomaly-modal` ×6 + "Select all squares…". `lite.duckduckgo.com/lite/` (POST `q=`) → **202**, same marker. Both are the CAPTCHA wall, not an empty SERP.
- `uddg=` has already been percent-decoded once by the query parser; decoding again turns `…/wiki/C%2B%2B` into `C++` and 404s.
- `api.duckduckgo.com/?format=json` is **not a web index**: **[V]** 200 with empty `Abstract`/`Results`/`RelatedTopics` for `rust ownership`. Instant-Answer API only.

## 6. bing — **[B]** today (the interesting one)

```js
// pre-step: GET https://www4.bing.com/ for a cookiejar (TTL 1800 s, reused across queries, keyed by
// proxy egress, single-flight). Then use www4, NOT www (www challenges headless clients):
const url = `https://www4.bing.com/search?q=${encodeURIComponent(q)}&form=QBRE`
  + (f ? `&filters=${encodeURIComponent({ day: 'ex1:"ez1"', week: 'ex1:"ez2"', month: 'ex1:"ez3"', year: 'ex1:"ez4"' }[f])}` : '')
  + (adlt ? `&adlt=${adlt}` : '')       // strict|moderate|off
  + (mkt ? `&mkt=${mkt}` : '');         // us-en -> en-US ; UK -> GB
// form=QBRE required; form=QBLH is a lighter layout with NO .b_algo at all. NEVER send count=.
const LI  = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/g;
const A   = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/;
const SNP = /class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/;   // || .b_lineclamp4|.b_lineclamp2|.b_paractl
// pagination for 11-20: append &first=11 — the way a person gets them; never count=
function unwrapBing(href) {                       // bing.com/ck/a?…&u=a1<base64url>
  if (!href.includes('bing.com/ck/a')) return href;
  const u = new URL(href, 'https://www.bing.com').searchParams.get('u') ?? '';
  if (u.length < 3) return href;
  const p = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
  const b = Buffer.from(p + '='.repeat(-p.length % 4), 'base64').toString('utf8');
  return /^https?:\/\//.test(b) ? b : href;       // only accept a decoded absolute URL
}
```

- **[B]** `www.bing.com/search?q=rust+ownership&form=QBLH` → 200, 129 KB, 10 `li.b_algo`, 29 `ck/a`, and every decoded target is a Microsoft property: `microsoft.com/en-in/microsoft-365/outlook/log-in`, `m365.cloud.microsoft/?omkt=en-GB`, `myaccount.microsoft.com/login`, `outlook.office.com/mail/inbox`. `rust-lang` occurs **0 times** in the whole page. This is the decoy page, not a wall: valid markup, real titles, useless rows.
- Re-ran the upstream recipe verbatim (`GET https://www4.bing.com/` for cookies, then `?q=rust+ownership+borrowing&form=QBRE`): still 200 / 10 `b_algo` / **`rust-lang` = 0**. The cookiejar did not rescue this egress; only the coherence check would catch it.
- Why the shape matters [S]: measured upstream — no cookies → decoy; `count=` → decoy (no browser sends it); cookies + `form=QBRE` + no `count=` → real. Re-mint once on a decoy, then return it and let the aggregator drop the bucket.

## 7. brave — **[B]** today

```js
const url = `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`
  + (f ? `&tf=${{ day: 'pd', week: 'pw', month: 'pm', year: 'py' }[f]}` : '')
  + (safe ? `&safesearch=${safe}` : '')   // strict|moderate|off
  + (cc ? `&country=${cc}` : '');         // 2-letter, from 'us-en' -> us
// upstream: needs_browser = true, wait_selector '#results, .snippet' (proof-of-work captcha)
const SNIP = /<div[^>]*class="[^"]*\bsnippet\b[^"]*"[^>]*data-type="web"[^>]*>/g;  // one selector only
const A = /<a[^>]*href="([^"]+)"/;
const T = /class="(?:title|snippet-title)"[^>]*>([\s\S]*?)<\/(?:div|span|a)>/;
const D = /class="snippet-(?:description|content|content-summary)"[^>]*>([\s\S]*?)<\/(?:div|p)>/;
```

- **[B]** **429**, 76 KB, page contains `Too many` / `captcha` / `verify`. Its anti-bot is a proof-of-work challenge, so the upstream fix is a browser render; a plain HTTP client will not pass.

## 8. googlenews (RSS) — **[V]** · wikipedia — **[V]**

```js
const gurl = `https://news.google.com/rss/search?q=${encodeURIComponent(q + (f ? ` when:${{ day: '1d', week: '7d', month: '1m', year: '1y' }[f]}` : ''))}&hl=en-US&gl=US&ceid=US:en`;
const ITEM = /<item>([\s\S]*?)<\/item>/g;
const T = /<title>([\s\S]*?)<\/title>/, L = /<link>([\s\S]*?)<\/link>/;
const SRC = /<source[^>]*>([\s\S]*?)<\/source>/, D = /<pubDate>([\s\S]*?)<\/pubDate>/;
const wurl = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json`
  + `&srsearch=${encodeURIComponent(q)}&srlimit=${Math.min(Math.max(n, 1), 50)}`;
const wSnippet = hit.snippet.replace(/<[^>]+>/g, '');   // strips <span class="searchmatch"> highlights
const wUrl = `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(hit.title.replace(/ /g, '_'));
```

- **[V]** RSS: 200, 44 KB, **34 `<item>`**, RFC-2822 `pubDate`, titles server-truncated (`A Grounded Conceptual Model for Ownership Types in`).
- **[V]** `ceid` is edition-scoped, not a hint: upstream measured **0 items** for a Chinese query on `US:en` vs **35** on `CN:zh-Hans`. Derive it from the query's script (`zh`+`TW/HK/MO`→`zh-Hant`, `zh`+`CN/SG`→`zh-Hans`), else an empty feed reads as an IP block.
- **[V]** `<link>` is `https://news.google.com/rss/articles/CBM…` — an opaque blob, so every item's host is `news.google.com`, killing `site:` filtering and cross-engine dedup. Upstream replays Google's own RPC (`gnews.py`) inside a fixed budget; skip that and you must at least append the outlet (` (${source})`).
- **[V]** wikipedia API: 200 JSON, 5 hits (`Rust (programming language)`, `Rust syntax`, …). Language comes from `region`'s lang half (`us-en`→`en`, `cn-zh`→`zh`), validated before it is interpolated into a hostname.

## 9. anysearch — **[V]** reachable, junk for this query

```js
const r = await fetch('https://api.anysearch.com/v1/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },      // NO Authorization header => anon tier
  body: JSON.stringify({ query: q, max_results: n }),   // clamp 1..100
});
const j = await r.json();                               // {code:0,message:'success',data:{results:[…]}}
const rows = j?.data?.results ?? j?.results ?? [];      // tolerate a flat shape
// item: title, url, snippet = longer of (snippet|description|content); published_at -> YYYY-MM-DD
```

- **[V]** 200 in 1.9 s, `code:0`, 5 results. Live item keys are **`{title,url,snippet,content}`** — no `description`, no `published_at`, no `score`. Upstream's mapper reads `description`/`content`/`published_at`; add `snippet`.
- **[V]** Quality is the real problem: for `rust ownership` it returned `doi.org/10.5281/zenodo.17810806` "Review on Rusting Factors", a DTIC "Rust Damage to the M880" survey, `tpc.105.040212` "Rust Fungi Avirulence Elicitors" — metal rust, not the language. It sits in upstream's *default pool*; a coherence guard around it is mandatory.
- Operators are **not** honoured (`-site:stackoverflow.com` returned stackoverflow.com first) → post-filter. Anon tier is IP rate-limited: 429/5xx/malformed → `[]`, but record `http_status` so a 429 cannot look like "found nothing".

## 10. searx / mojeek / startpage — **[B]**, probe-derived only

```js
// SearXNG, if you host one (format=json must be enabled in settings.yml):
const url = `https://<instance>/search?q=${encodeURIComponent(q)}&format=json` + (page ? `&pageno=${page}` : '');
// -> {results:[{url, title, content, publishedDate, engine, score, category}], number_of_results}
// HTML fallback selectors: article.result > h3 > a (href is direct), .content, .url_wrapper
```

- **[V]** Every SearXNG instance probed refuses JSON: `searx.be` 200 but `<title>Verifying your browser…</title>` + `/antibot/captcha`; `priv.au`, `opnxng.com`, `search.sapti.me`, `search.rhscz.eu`, `searx.tiekoetter.com` **429**; `baresearch.org` and `search.inetol.net` an Anubis "Making sure you're not a bot!" gate; `searxng.site` **403**; `search.hbubli.cc` / `searx.oloke.xyz` 200 but return **HTML** (format=json ignored). Practical answer: **do not depend on a public SearXNG instance** — self-host or drop it.
- mojeek: `curl` dies at the TLS layer (`error:0A000126:SSL routines::unexpected eof`) from this host. Upstream lists Mojeek markers in its gate table (`altcha`, `captcha-wrap`) but ships **no mojeek engine file** — don't plan around it. startpage: 200, 22 KB, `captcha` ×3, zero result containers. yahoo.com: 500.
- `r.jina.ai` reader: **[V]** **401** `AuthenticationRequiredError … blocked … bad IP reputation`, and no rate-limit header — the free no-key reader proxy is no longer keyless from a bad IP.

---

## Fetch / extraction (upstream `fetcher.py` + `documents.py`)

1. **HTTP GET** with a byte cap + redirect/charset loop (`httpfetch.curl_stream_capped`); `fetch_timeout = 25 s`, search requests use `request_timeout = 15 s`.
2. **Content-type gate**: only `text/html`/XML reach the extractor. PDF/DOCX → document reader; images → asset path; anything else → an explicit "unsupported" error rather than a mangled body.
3. **Main content: `trafilatura`** — `load_html` once (shared lxml tree for metadata + extract), `extract_metadata` → `{title, author, date, sitename}`, then `extract(output_format="markdown", include_links=True, include_tables=True, favor_precision=True)`.
4. **Fallback when that yields nothing**: `selectolax` boilerplate strip (`_BOILERPLATE` tags decomposed) + region heuristic `article → main → [role=main] → #content → .content → body`, then `markdownify` → Markdown with blank lines collapsed.
5. **Truncate** to `max_content_chars = 50_000` via `smart_truncate` (also returns `truncated: true`).
6. **PDF/DOCX**: `pypdf` / `python-docx`, capped at `max_pdf_pages = 200` **and** a total-text cap (decompression-bomb defence); a failed page is logged and skipped, not fatal. If the extension promised a binary but the body is HTML, the body is re-routed to the HTML path (soft failure).
7. **Blocked page / JS shell**: `fetch_strategy = auto` → on an HTTP error, re-render with Playwright using the engine's `wait_selector`; an `http_walls` cache makes the next attempt browser-first for a while. `fetch_strategy` can pin `http`|`browser`.
8. **For a Node port**: steps 3/4 are the only irreducibly DOM-ish part, and `favor_precision` has no drop-in. Regex `<article>`/`<main>` + `strip tags → collapse whitespace → drop lines < 40 chars` is the pragmatic replacement; readability-style line scoring is the upgrade path.
9. **Regex discipline** (why upstream iterates containers first): non-greedy `[\s\S]*?`, always bound with the next `</div>`/`</p>`/`</a>`, and prefer *attribute* matches (`data-*`, `class="…"`) over nesting assumptions — otherwise two sibling results merge into one.

---

## Local probes I ran

`curl -sS --max-time 25 -A '<Chrome131 UA>' -H 'Accept: text/html,…' -H 'Accept-Language: en-US,en;q=0.9' <url>`, bodies in `.probe/t_*`. SERP query everywhere: `rust ownership`.

| target | code | bytes | result markup | verdict |
|---|---|---|---|---|
| `search.brave.com/search?q=…` | **429** | 76044 | 0 snippets | blocked: "Too many"/captcha interstitial |
| `www.bing.com/search?q=…&form=QBLH` | 200 | 128848 | 10 `b_algo`, 29 `ck/a` | **decoy** — all microsoft.com/m365; `rust-lang`×0 |
| `www4.bing.com` warm + `&form=QBRE` | 200 | 127966 | 10 `b_algo`, 29 `ck/a` | **still decoy** — `rust-lang`×0 |
| `search.yahoo.co.jp/search?p=…` | 200 | 506610 | 9 `sw-Card Algo` | **works**: doc.rust-lang.org + reddit |
| `www.baidu.com/s?wd=…` | 200 | 860037 | 10 containers, 11 `mu` | **works**: jianshu/163/fpcomplete/cnblogs/zhihu |
| `www.so.com/s?q=…` | 200 | 393793 | 7 `res-list`, 14 `data-mdurl` | **works**: 10/14 pass an internal-host filter; href = `/link?m=` wrapper |
| `www.sogou.com/web?query=…` | 200 | 512964 | 11 `vrwrap`, 11 `data-url` | **works** via `data-url`; href follow → sogou homepage |
| `html.duckduckgo.com/html/?q=…` | **202** | 14250 | `anomaly-modal`×6 | blocked: CAPTCHA |
| `lite.duckduckgo.com/lite/` (POST) | **202** | 14244 | `anomaly-modal`×56 | blocked: same wall |
| `api.duckduckgo.com/?format=json` | 200 | 1252 | `Results: []` | Instant-Answer API, **not** a web index |
| `news.google.com/rss/search?…&ceid=US:en` | 200 | 44256 | 34 `<item>` | **works** (links are `CBM…` blobs) |
| `en.wikipedia.org/w/api.php…` | 200 | 2241 | 5 hits | **works** |
| `api.anysearch.com/v1/search` (anon POST) | 200 | 8640 | `code:0`, 5 results | reachable, results are **metal rust** |
| `r.jina.ai/https://example.com` | **401** | 343 | JSON error | blocked: bad IP reputation, no rate-limit header |
| `searx.be/search?q=test&format=json` | 200 | 11354 | "Verifying your browser…" | **not JSON** |
| `priv.au` / `opnxng.com` / `search.sapti.me` / `search.rhscz.eu` / `searx.tiekoetter.com` | **429** | 17 | — | no JSON |
| `baresearch.org` / `search.inetol.net` | 200 | 4479 / 9130 | Anubis "not a bot!" | no JSON |
| `searxng.site` | **403** | 278 | — | no JSON |
| `search.hbubli.cc` / `searx.oloke.xyz` | 200 | 7135 / 3377 | HTML SERP | `format=json` ignored |
| `www.mojeek.com/search?q=…` | 000 | 0 | — | TLS handshake failure (7.7 s) |
| `www.startpage.com/sp/search?query=…` | 200 | 22099 | captcha×3, 0 results | blocked |
| `search.yahoo.com/search?p=…` | **500** | 0 | — | blocked |

External result links (these regexes re-run in Node against the saved bodies): yahoojp 9 cards / 9 summaries · baidu 10 boxes / 11 `mu` / **8 external** · so360 7 items / 14 `data-mdurl` / **10 after** filtering 360's own chrome · sogou 10 `vrwrap` + 1 hint box / **11 `data-url`** · bing 10 `b_algo` with `rust-lang`×0 · googlenews 34 items · wikipedia 5 · anysearch 5 (off-topic) · brave 0 · ddg 0.
