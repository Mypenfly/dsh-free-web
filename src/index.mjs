/**
 * dsh-free-web — free providers for the host's built-in `web_search` / `web_fetch`.
 *
 * The tools themselves are not touched: `@deepseek-ai/dsh-tool-web` keeps its
 * names, schemas, and prompt sections, and calls `ctx.web`. This plugin registers
 * into that seam, so "taking over the web tools" means "be the provider the seam
 * selects" — no tool is added, and no system prompt text is injected.
 *
 * Mount it as a normal row in the profile patch:
 *
 *     - id: free-web
 *       name: /abs/path/to/free-web/src/index.mjs
 *       config:
 *         engines: [yahoojp, so360, sogou, wikipedia]
 *
 * and point the seam at the ids it registers (the `web` row of the base profile
 * declares `searchProvider: deepseek-official` / `fetchProvider: http`, so the
 * override belongs in the same patch):
 *
 *     - id: web
 *       config:
 *         searchProvider: free-search
 *         fetchProvider: free-fetch
 *
 * Equivalent, without editing the patch: `DSH_WEB_SEARCH_PROVIDER=free-search` and
 * `DSH_WEB_FETCH_PROVIDER=free-fetch` in the launching environment. The engine pool
 * has the same kind of override, `DSH_FREE_WEB_ENGINES=sogou,wikipedia`, which wins
 * over the row's `config.engines`.
 */

import { ENGINE_ENV, enginesFromEnv, resolveEngines } from './search/engines/index.mjs'
import { FreeSearchProvider } from './search/provider.mjs'
import { FreeFetchProvider } from './fetch/provider.mjs'

/** Loader name shown in diagnostics. */
export const name = 'free-web'

/** The seam this plugin registers into; without it there is nothing to take over. */
export const inject = ['web']

/** Default ids; the `web` row must be pointed at these. */
const DEFAULT_SEARCH_ID = 'free-search'
const DEFAULT_FETCH_ID = 'free-fetch'

/** Default per-engine budget; a slow engine must not hold the tool call open. */
const DEFAULT_ENGINE_TIMEOUT_MS = 8000

/**
 * Register the providers.
 *
 * @param {object} ctx plugin context (must expose `web`)
 * @param {object} [config] row config
 * @param {string} [config.searchProvider] id to register the search provider under
 * @param {string} [config.fetchProvider] id to register the fetch provider under
 * @param {string[]} [config.engines] engine ids, in preference order
 * @param {number} [config.engineTimeoutMs] per-engine budget
 * @param {string} [config.acceptLanguage] Accept-Language sent to engines
 * @param {boolean} [config.search] register the search provider (default true)
 * @param {boolean} [config.fetch] register the fetch provider (default true)
 * @param {boolean} [config.provenance] prefix search results with an engine summary (default true)
 * @param {boolean} [config.verbose] write one mount line to stderr (for verifying a mount)
 */
export function apply(ctx, config = {}) {
  const log = (message, detail) => {
    try {
      if (detail === undefined) ctx.logger?.info?.(message)
      else ctx.logger?.info?.(`${message} ${String(detail)}`)
    } catch {
      // A logger is a convenience, never a reason to fail mounting.
    }
  }
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // same
    }
  }

  if (config.search !== false) {
    // The environment wins over the row config: it is the escape hatch for a pool
    // that went bad from this egress IP, and it survives bundle updates. A variable
    // that resolves to nothing usable falls back to the config, so a typo costs a
    // warning rather than the tool.
    const override = enginesFromEnv()
    let engines = resolveEngines(override ?? config.engines, warn)
    if (override !== undefined) {
      if (engines.length > 0) {
        const line = `free-web: engine pool overridden by ${ENGINE_ENV}=${override.join(',')}`
        log(line)
        if (config.verbose === true) process.stderr.write(`${line}\n`)
      } else {
        warn(`free-web: ${ENGINE_ENV}="${override.join(',')}" has no usable engine; falling back to the configured pool`)
        engines = resolveEngines(config.engines, warn)
      }
    }
    if (engines.length === 0) {
      warn('free-web: no usable search engine configured; the search provider stays unmounted')
    } else {
      const provider = new FreeSearchProvider({
        id: typeof config.searchProvider === 'string' && config.searchProvider.length > 0 ? config.searchProvider : DEFAULT_SEARCH_ID,
        engines,
        timeoutMs: positiveNumber(config.engineTimeoutMs, DEFAULT_ENGINE_TIMEOUT_MS),
        acceptLanguage: typeof config.acceptLanguage === 'string' && config.acceptLanguage.length > 0
          ? config.acceptLanguage
          : 'en-US,en;q=0.9,zh-CN;q=0.8,ja;q=0.7',
        provenance: config.provenance !== false,
        log: warn,
      })
      ctx.web.registerSearchProvider(provider)
      const line = `free-web: search provider "${provider.id}" registered with engines [${engines.map((engine) => engine.id).join(', ')}]`
      log(line)
      if (config.verbose === true) process.stderr.write(`${line}\n`)
    }
  }

  if (config.fetch !== false) {
    const provider = new FreeFetchProvider({
      id: typeof config.fetchProvider === 'string' && config.fetchProvider.length > 0 ? config.fetchProvider : DEFAULT_FETCH_ID,
      ...(typeof config.fetchTimeoutMs === 'number' ? { timeoutMs: config.fetchTimeoutMs } : {}),
      ...(typeof config.maxBodyChars === 'number' ? { maxBodyChars: config.maxBodyChars } : {}),
      log: warn,
    })
    ctx.web.registerFetchProvider(provider)
    const line = `free-web: fetch provider "${provider.id}" registered (reader-mode extraction)`
    log(line)
    if (config.verbose === true) process.stderr.write(`${line}\n`)
  }
}

/**
 * Read a positive finite number, falling back to a default.
 * @param {unknown} value configured value
 * @param {number} fallback default
 * @returns {number} usable value
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
