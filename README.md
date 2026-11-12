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
# that writes both halves: the link: dependency and the `dsh.profile.bundles` entry
# (or install the directory from Plugins → Add plugin and press Enable now)
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
node --test "test/*.test.mjs"     # 48 offline tests: fixtures, local servers, proxy rules
node scripts/smoke.mjs            # live: one search + two fetches
node scripts/probe-live-tool.mjs web_search "rust ownership"   # live: the host kernel calls the tool
node scripts/probe-live-tool.mjs web_fetch https://example.com/
node scripts/measure-wire.mjs baseline
node scripts/measure-wire.mjs withplugin --with-plugin   # compare system prompt + tool list
```

`probe-live-tool.mjs` streams a scripted `tool_use` from a mock Messages endpoint, so the real
DSH kernel executes the real built-in tool — no paid call, and the tool result is captured in
the follow-up request:

```
tool: web_search({"queries":["rust ownership"]})
result: 2201 chars
Engines: yahoojp 9 · so360 6 · sogou 10 · wikipedia 8

Sources:
- [Understanding Ownership - The Rust Programming Language](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html) — Ownership is Rust's most unique feature …

tool: web_fetch({"url":"https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html"})
result: 564 chars
# Understanding Ownership  … article body, no navigation
```

And in the live desktop session, the same built-in tools answered through the mounted bundle:

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
| `DSH_FREE_WEB_ENGINES` (env) | unset | comma/space separated override of `engines`; wins over the row config, unknown ids only warn |
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

- **Transport.** HTTP is the plugin's own stack on Node core (`node:http`, `node:https`,
  `node:tls`, `node:zlib`) — no global `fetch`, no client library, no undici dispatcher. Proxy
  settings are read from the environment with the same precedence curl uses: scheme-specific
  `http_proxy` / `https_proxy`, `all_proxy` as fallback, `no_proxy` for `*`, exact hosts, domain
  suffixes, `host:port`, bracketed IPv6 and IPv4 CIDR. `https:` targets go through `CONNECT` +
  TLS, `http:` targets through an absolute-form request line. A `socks*://` value is not
  implemented and therefore means "direct", not a silent half-proxy.
- **DNS pinning.** A direct connection resolves once, refuses the request if *any* answer is
  non-public, and pins the verified set into the socket, so the name cannot resolve differently
  between check and connect. Behind a proxy the destination is resolved by the proxy, but the
  same public-only check still runs before the tunnel opens.
- **Encodings.** `gzip`, `deflate` (zlib-wrapped and raw) and `br` are decoded in-process. The
  decoded size is capped, so a small compressed body cannot expand into a bomb.
- **Redirects.** The transport is one hop per call; the fetch provider validates origin and
  address on every hop, and the engines follow up to 6 hops.
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
src/util/transport.mjs      own HTTP transport: direct + proxy, one hop per call, decoding
src/util/proxy.mjs          proxy variables and no_proxy matching
src/util/address.mjs        non-public destination policy (shared by transport and provider)
src/util/*.mjs              http, html, url, dates, errors
cordis.patch.yml            bundle patch: insert the row, re-point the `web` seam
dsh-plugin.json             plugin manifest (display metadata, host facet)
locale/{en,zh}.json         title + description shown in Plugins
assets/icon.png             icon shown in Plugins
mount.patch.yml             manual mount overlay (absolute path, no bundle)
scripts/smoke.mjs           live search + fetch through the real providers
scripts/probe-live-tool.mjs the host kernel calling a real built-in tool, scripted by a mock LLM
scripts/measure-wire.mjs    capture the model-visible prompt and tool list
test/fixtures/              captured engine responses + one article page
docs/ENGINES.md             per-engine recipes and probe results
docs/MOUNT.md               installing, verifying, rolling back
```

## License

MIT. Engine recipes were informed by [sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp) (MIT), whose Python implementations and measurements are credited in `docs/ENGINES.md`.
