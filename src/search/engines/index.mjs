/**
 * Engine registry. Each entry is a module shaped
 * `{ id, label, search(query, options) }`; the provider owns timeouts, benching,
 * and merging, so an engine only has to turn one query into sources or throw.
 */

import * as bing from './bing.mjs'
import * as yahoojp from './yahoojp.mjs'
import * as so360 from './so360.mjs'
import * as brave from './brave.mjs'
import * as sogou from './sogou.mjs'
import * as duckduckgo from './duckduckgo.mjs'
import * as baidu from './baidu.mjs'
import * as wikipedia from './wikipedia.mjs'

/** Every engine this plugin ships, keyed by id. */
export const ENGINES = new Map(
  [yahoojp, so360, sogou, wikipedia, duckduckgo, bing, brave, baidu].map((engine) => [engine.id, engine]),
)

/**
 * Default pool: the engines measured from this egress IP as returning real
 * destinations on repeated use. Everything left out is one config line away and
 * documented in README.md:
 *  - `bing`, `brave` — decoy page / proof-of-work 429 from this IP;
 *  - `baidu` — CAPTCHA-prone, and its direct URLs exist only on some days.
 * `duckduckgo` is in the pool but gated: it only answers when the request carries a
 * referer, so its failures are expected and benched like any other engine.
 */
export const DEFAULT_ENGINES = ['yahoojp', 'so360', 'sogou', 'wikipedia', 'duckduckgo']

/**
 * Environment variable that overrides the configured pool.
 *
 * Shrinking the pool is an operational decision (an engine starts serving CAPTCHAs
 * from this egress IP, a CI run needs a single deterministic engine), and that
 * should not require editing a YAML file that a bundle update will overwrite.
 */
export const ENGINE_ENV = 'DSH_FREE_WEB_ENGINES'

/**
 * Parse an engine list: comma or whitespace separated, case-insensitive, deduped.
 *
 * @param {unknown} value raw variable or config value
 * @returns {string[]} engine ids, in the order given
 */
export function parseEngineList(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const seen = new Set()
  const ids = []
  for (const token of value.split(/[,\s]+/)) {
    const id = token.trim().toLowerCase()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Engine ids from the environment, or `undefined` when the variable says nothing.
 *
 * @param {Record<string, string | undefined>} [env] environment to read
 * @returns {string[] | undefined} override list, or `undefined` to keep the config
 */
export function enginesFromEnv(env = process.env) {
  const ids = parseEngineList(env[ENGINE_ENV])
  return ids.length === 0 ? undefined : ids
}

/**
 * Resolve a configured engine list, reporting unknown ids instead of failing the
 * whole plugin: a typo should cost one engine, not the search tool.
 *
 * @param {unknown} configured value from plugin config
 * @param {(message: string) => void} [warn] reporter for unknown ids
 * @returns {Array<typeof bing>} the resolved engine modules, in configured order
 */
export function resolveEngines(configured, warn = () => {}) {
  const value = unwrapVolatile(configured)
  const ids = Array.isArray(value) && value.length > 0 ? value : DEFAULT_ENGINES
  const engines = []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const engine = ENGINES.get(id)
    if (engine === undefined) {
      warn(`free-web: unknown engine "${id}" ignored (known: ${[...ENGINES.keys()].join(', ')})`)
      continue
    }
    engines.push(engine)
  }
  return engines
}

/**
 * Unwrap a live config reference.
 *
 * A `.volatile()` field is committed in place, so the plugin receives
 * `{ get(): value }` rather than the value itself. Reading it here keeps every
 * caller (and the live pool getter in `index.mjs`) free of that detail.
 *
 * @param {unknown} value config value or a volatile reference to it
 * @returns {unknown} the value behind the reference, when there is one
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}
