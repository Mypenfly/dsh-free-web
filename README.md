# dsh-free-web

Free providers for the DeepSeek Harness built-in **`web_search`** and **`web_fetch`** tools.

The tools themselves are untouched. `@deepseek-ai/dsh-tool-web` keeps its names, schemas, and prompt sections; it calls `ctx.web`, and this plugin registers into that seam. "Taking over the web tools" therefore means *being the provider the seam selects* — no tool is added, no system-prompt text is injected, and the model-visible surface is byte-identical to stock DSH.

Measured on a headless DSH 2.0.22 run (`scripts/measure-wire.mjs`, mock Messages endpoint):

| arm | system prompt | tools | prompt mentions the plugin |
|---|---|---|---|
| stock | 2,591 chars | 24 (`web_search`, `web_fetch`) | no |
| with dsh-free-web | **2,591 chars** | **24** | **no** |

## Why

Stock DSH routes `web_search` through `deepseek-official`: an auxiliary Messages request with the server-side `web_search` tool, billed per search. `web_fetch` already uses the local `dsh-web-fetch-http` provider, so fetch was never the paid half — what it lacked was *extraction*: it hands back the raw document, and the model pays for navigation, cookie banners, and related-links rails.

This plugin replaces both halves:

- **search** — a pool of keyless public result pages, fused with Reciprocal Rank Fusion;
- **fetch** — the same anonymous HTTP policy, but the body is the article, converted to Markdown.

## What it does not do

- No system-prompt section, no persona, no tool description edit.
- No new tool, no renamed tool, no MCP server.
- No API key, no account, no billing endpoint. Every request goes to a public search result page or the target site itself.

## Engines

Live probes from a consumer IP behind an HTTP proxy, 2026-11-11 (details and per-engine recipes in [docs/ENGINES.md](docs/ENGINES.md)):

| engine | status here | notes |
|---|---|---|
| `yahoojp` | **works** | Yahoo! JAPAN — the keyless route to a Google-class index; direct destination URLs |
| `so360` | **works** | 360 Search; destination in `data-mdurl`; CAPTCHA-prone under load |
| `sogou` | **works** | destination in `data-url`; needs a session cookie (minted once per process) |
| `wikipedia` | **works** | MediaWiki JSON API; encyclopedic queries only, never benched |
| `duckduckgo` | **works** | `html.duckduckgo.com` only answers with a `referer` — without it the same URL is a 202 CAPTCHA. `uddg=` links unwrap to real destinations |
| `bing` | decoy page | 200 + perfectly shaped rows that are all off-topic; the coherence gate drops them |
| `brave` | HTTP 429 | proof-of-work interstitial from a shared proxy IP |
| `baidu` | CAPTCHA | `百度安全验证` most days; direct URLs are behind an opaque token |

Default pool (`src/search/engines/index.mjs`): `yahoojp`, `so360`, `sogou`, `wikipedia`, `duckduckgo`. The mounted desktop row lists the same five. The rest are one config line away.

Two guards make a flaky pool usable:

- **benching** — an engine that fails twice is skipped for 2 minutes (×2 per re-offence, capped at 1 hour), so a CAPTCHA engine costs one request, not one per query;
- **coherence gate** — an engine whose rows mention none of the query terms is a decoy page, not a result set, and its bucket is dropped. This is what keeps Bing's Microsoft-365 page from ever reaching the model as "results".

## Install

The package is a DSH bundle (`dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)), so
an install is a dependency plus a selection — the patch rows come with it:

```bash
dsh plugin --profile desktop add link:/home/mypenfly/projects/dsh-plugins/free-web
# then add "dsh-free-web" to dsh.profile.bundles in the profile's package.json,
# or install the directory from Plugins → Add plugin and press Enable now
```

It then appears in **Plugins** with its own title, description, and icon, and its switch is
the rollback: switched off, the row unmounts and the seam falls back to
`searchProvider: deepseek-official` / `fetchProvider: http`.

The bundle patch is two entries — insert the row, re-point `web`:

```yaml
- insert:
    - id: free-web
      name: dsh-free-web          # bare package name: the profile resolves it
      config:
        engines: [duckduckgo, yahoojp, so360, sogou, wikipedia]
- id: web
  config:
    searchProvider: free-search
    fetchProvider: free-fetch
```

Mounting by path instead (a `--patch` overlay, a profile that keeps plugins as file paths)
is in [docs/MOUNT.md](docs/MOUNT.md); such a row is not listed on the Plugins page, which
only manages packages. Without editing anything, the same selection can come from the
environment: `DSH_WEB_SEARCH_PROVIDER=free-search DSH_WEB_FETCH_PROVIDER=free-fetch dsh web`.

## Verification

```bash
node --test "test/*.test.mjs"     # 29 offline tests over captured fixtures
node scripts/smoke.mjs            # live: one search + two fetches
node scripts/measure-wire.mjs baseline
node scripts/measure-wire.mjs withplugin --with-plugin   # compare system prompt + tool list
```

Inside a running DSH the seam path was exercised end to end (probe plugin calling `ctx.web` after mount):

```
PROBE search sources=5 content="Engines: yahoojp 9 · sogou 9 · wikipedia 5 · skipped: so360 unavailable"
PROBE search first=https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html
PROBE fetch status=200 chars=156 kind=text
```

And in the live desktop session, after mounting the row, the built-in tool itself answered with the
same provenance line:

```
web_search { queries: ["dsh-free-web keyless search provider"] }
→ Engines: yahoojp 9 · sogou 11 · duckduckgo 10 · skipped: so360 unavailable, wikipedia unavailable
web_fetch { url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html" }
→ "# Understanding Ownership" … article body, no navigation
```

## Configuration

| key | default | meaning |
|---|---|---|
| `engines` | `[yahoojp, so360, sogou, wikipedia, duckduckgo]` | engine ids, in preference order (order breaks ties in fusion) |
| `searchProvider` | `free-search` | id the search provider registers under |
| `fetchProvider` | `free-fetch` | id the fetch provider registers under |
| `engineTimeoutMs` | `8000` | per-engine budget inside one search |
| `acceptLanguage` | `en-US,en;q=0.9,zh-CN;q=0.8,ja;q=0.7` | header sent to engines |
| `provenance` | `true` | prefix results with `Engines: …` so a thin result is distinguishable from a broken pool |
| `search` / `fetch` | `true` | register each half independently |
| `fetchTimeoutMs` | `30000` | total fetch budget |
| `maxBodyChars` | `100000` | cap on returned characters |
| `verbose` | `false` | write one mount line to stderr |

## Limits worth knowing

- **Proxy.** The providers use the host's global `fetch`, so they inherit DSH's proxy policy automatically. A machine that needs a proxy but has none configured will find every engine "unavailable".
- **DNS pinning.** The shipped fetch provider resolves and pins addresses before connecting. A plugin cannot (that needs the undici dispatcher's `lookup`), so this fetch validates the URL and pre-resolves the hostname instead — enough to refuse `localhost`, private, link-local, and CGNAT destinations, not a rebinding race.
- **Selectors are rented, not owned.** Every engine is a public page whose markup can change; the tests run against captured fixtures, so a break shows up as a failing test, and the breaker keeps the rest of the pool answering.
- **No browser rendering.** JavaScript-only pages and proof-of-work walls (Brave) are out of reach; there is no Playwright here.

## Layout

```
src/index.mjs              plugin entry: registers both providers
src/search/provider.mjs     pool runner: concurrency, benching, decoys, fusion, memo
src/search/rank.mjs         RRF + canonical dedupe
src/search/gates.mjs        wall markers + coherence/decoy gate
src/search/engines/*.mjs    one module per engine (buildUrl + extract + search)
src/fetch/provider.mjs      SSRF policy, redirects, caps, content types
src/fetch/reader.mjs        article extraction → Markdown
src/util/*.mjs              http, html, url, dates, errors
cordis.patch.yml            bundle patch: insert the row, re-point the `web` seam
dsh-plugin.json             plugin manifest (display metadata, host facet)
locale/{en,zh}.json         title + description shown in Plugins
assets/icon.png             icon shown in Plugins
mount.patch.yml             manual mount overlay (absolute path, no bundle)
test/fixtures/              captured engine responses + one article page
docs/ENGINES.md             per-engine recipes and probe results
docs/MOUNT.md               installing, verifying, rolling back
```

## License

MIT. Engine recipes were informed by [sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp) (MIT), whose Python implementations and measurements are credited in `docs/ENGINES.md`.
