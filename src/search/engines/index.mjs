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
 * Resolve a configured engine list, reporting unknown ids instead of failing the
 * whole plugin: a typo should cost one engine, not the search tool.
 *
 * @param {unknown} configured value from plugin config
 * @param {(message: string) => void} [warn] reporter for unknown ids
 * @returns {Array<typeof bing>} the resolved engine modules, in configured order
 */
export function resolveEngines(configured, warn = () => {}) {
  const ids = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_ENGINES
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
