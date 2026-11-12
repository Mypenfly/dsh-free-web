# dsh-free-web

Free providers for the DeepSeek Harness built-in **`web_search`** and **`web_fetch`** tools.

The tools themselves are untouched: `@deepseek-ai/dsh-tool-web` keeps its names, schemas, and
prompt sections and calls `ctx.web`, and this plugin registers into that seam. No tool is added,
no prompt text is injected — the model-visible surface is identical to stock DSH (2,591
system-prompt chars, 24 tools, both arms).

- **search** — a pool of keyless public result pages (`yahoojp`, `sogou`, `so360`, `wikipedia`,
  `duckduckgo` by default), fused with Reciprocal Rank Fusion behind a circuit breaker and a
  decoy-page gate;
- **fetch** — the same anonymous HTTP policy, but the body is the article, converted to Markdown.

No API key, no account, no billing endpoint: every request goes to a public result page or the
target site itself.

## Install

```bash
git clone https://github.com/Mypenfly/dsh-free-web.git && cd dsh-free-web
dsh plugin --profile desktop add link:"$PWD"   # dependency + bundle selection, in one step
```

Verification, the manual (no-bundle) mount, and rollback: [docs/MOUNT.md](docs/MOUNT.md).

## The engine pool is yours

Pick engines in the card below, or on the row's own page (**Free web (keyless) ›**) — same
picker, same form. **Save** writes the pool to *your profile's* `cordis.patch.yml` as an override
of the bundle's list, and the mounted provider uses it on the next search — no restart.
**Restore defaults** deletes the override instead of writing a value.
`DSH_FREE_WEB_ENGINES="sogou,wikipedia"` wins over both.

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml  (written by the settings service)
- id: free-web
  config:
    engines: [sogou, wikipedia]
```

## More

- [docs/MOUNT.md](docs/MOUNT.md) — install, verify, roll back; the bundle patch and its rows
- [docs/ENGINES.md](docs/ENGINES.md) — per-engine recipes and probe results, every config key
- [docs/DESIGN.md](docs/DESIGN.md) — the seam, the wire measurement, transport limits, the
  browser half

Live check: `node --test "test/*.test.mjs"` (76 offline tests) and `node scripts/smoke.mjs`.

MIT. Engine recipes were informed by [sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp).
