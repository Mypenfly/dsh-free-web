/**
 * The free search provider registered into the host's `ctx.web` seam.
 *
 * Responsibilities the individual engines do not own:
 *  - run every configured engine concurrently under one deadline;
 *  - bench an engine that keeps failing (CAPTCHA, 429, parse miss) so the pool
 *    keeps answering instead of paying a doomed request per query;
 *  - drop decoy buckets (a 200 page of perfectly shaped, off-topic rows);
 *  - fuse survivors with RRF and cap to the request's `maxResults`;
 *  - report which engines answered, so an empty result is never ambiguous.
 */

import { fuse } from './rank.mjs'
import { isDecoy } from './gates.mjs'
import { providerError } from '../util/errors.mjs'
import { throwIfAborted } from '../util/http.mjs'

/** Consecutive engine failures before it is benched. */
const BENCH_AFTER = 2

/** First bench window, doubling per re-offence, capped. */
const BENCH_BASE_MS = 2 * 60 * 1000
const BENCH_MAX_MS = 60 * 60 * 1000

/** Query-memo TTL: keyless engines punish bursts, and the tool fans out queries. */
const CACHE_TTL_MS = 10 * 60 * 1000
/** Memo entries kept; oldest evicted first. */
const CACHE_LIMIT = 200

/**
 * One provider instance per mounted plugin.
 */
export class FreeSearchProvider {
  /** @type {string} */
  id

  /** @type {Map<string, { until: number, strikes: number }>} */
  #bench = new Map()

  /** @type {Map<string, { at: number, value: unknown }>} */
  #cache = new Map()

  /**
   * @param {object} options
   * @param {string} options.id provider id registered with the seam
   * @param {Array<{ id: string, search: (query: string, options: object) => Promise<Array<object>> }>} options.engines
   * @param {number} options.timeoutMs per-engine budget
   * @param {string} options.acceptLanguage Accept-Language for engine requests
   * @param {boolean} [options.provenance] prefix results with the engine summary
   * @param {(message: string, detail?: unknown) => void} [options.log] diagnostics sink
   * @param {() => number} [options.now] clock, injectable for tests
   */
  constructor(options) {
    this.id = options.id
    this.engines = options.engines
    this.timeoutMs = options.timeoutMs
    this.acceptLanguage = options.acceptLanguage
    this.provenance = options.provenance ?? true
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  /** Local usability check: at least one engine is configured. Never touches the network. */
  available() {
    return this.engines.length > 0
  }

  /**
   * Run one search across the pool.
   *
   * @param {{ query: string, maxResults?: number }} request seam request
   * @param {AbortSignal} [signal] cancellation
   * @returns {Promise<{ sources: Array<object>, truncated: boolean, content?: string }>} fused result
   */
  async search(request, signal) {
    throwIfAborted(signal)
    const query = request.query
    const limit = request.maxResults ?? 10
    const cacheKey = `${limit}\u0000${query}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined && this.now() - cached.at < CACHE_TTL_MS) {
      return /** @type {{ sources: Array<object>, truncated: boolean, content?: string }} */ (cached.value)
    }

    const outcomes = await Promise.all(
      this.engines.map(async (engine) => {
        const bench = this.#bench.get(engine.id)
        if (bench !== undefined && this.now() < bench.until) {
          return { engine: engine.id, status: 'benched', reason: `benched for ${Math.ceil((bench.until - this.now()) / 1000)}s` }
        }
        try {
          const sources = await engine.search(query, {
            signal,
            timeoutMs: this.timeoutMs,
            acceptLanguage: this.acceptLanguage,
            count: limit,
          })
          throwIfAborted(signal)
          const verdict = isDecoy(query, sources)
          if (verdict.decoy) {
            this.#strike(engine.id, `decoy page (coherence ${verdict.score.toFixed(2)})`)
            return { engine: engine.id, status: 'decoy', reason: `coherence ${verdict.score.toFixed(2)}` }
          }
          this.#bench.delete(engine.id)
          return { engine: engine.id, status: 'ok', sources }
        } catch (error) {
          throwIfAborted(signal)
          const reason = error instanceof Error ? error.message : String(error)
          this.#strike(engine.id, reason)
          this.log(`free-web: engine ${engine.id} failed: ${reason}`)
          return { engine: engine.id, status: 'failed', reason }
        }
      }),
    )

    const answered = outcomes.filter((outcome) => outcome.status === 'ok')
    if (answered.length === 0) {
      const detail = outcomes.map((outcome) => `${outcome.engine}: ${outcome.reason}`).join('; ')
      throw providerError(
        `every keyless engine failed for this query (${detail}). The free pool depends on public result pages; ` +
          'a proxy, a different egress IP, or enabling another engine (`engines` in the free-web config) usually restores it.',
      )
    }

    const { sources, perEngine, total } = fuse(
      answered.map((outcome) => ({ engine: outcome.engine, sources: outcome.sources })),
      { limit },
    )
    const value = {
      sources,
      truncated: total > sources.length,
      ...(this.provenance ? { content: summary(answered, outcomes, perEngine) } : {}),
    }
    this.#memoise(cacheKey, value)
    return value
  }

  /**
   * Record one failure and bench the engine once it crosses the strike limit.
   * @param {string} engineId engine id
   * @param {string} reason failure reason (for the log)
   */
  #strike(engineId, reason) {
    const previous = this.#bench.get(engineId)
    const strikes = (previous?.strikes ?? 0) + 1
    if (strikes < BENCH_AFTER) {
      this.#bench.set(engineId, { until: 0, strikes })
      return
    }
    const window = Math.min(BENCH_BASE_MS * 2 ** (strikes - BENCH_AFTER), BENCH_MAX_MS)
    this.#bench.set(engineId, { until: this.now() + window, strikes })
    this.log(`free-web: benching engine ${engineId} for ${Math.round(window / 1000)}s after "${reason}"`)
  }

  /**
   * Store one result in the memo, evicting the oldest entry past the cap.
   * @param {string} key cache key
   * @param {unknown} value result value
   */
  #memoise(key, value) {
    this.#cache.set(key, { at: this.now(), value })
    while (this.#cache.size > CACHE_LIMIT) {
      const oldest = this.#cache.keys().next()
      if (oldest.done === true) break
      this.#cache.delete(oldest.value)
    }
  }
}

/**
 * One-line provenance summary for the model-facing result.
 *
 * The seam exposes `content` as optional provider summary text; a single line that
 * names the engines and their row counts is what makes a thin result
 * distinguishable from a broken pool.
 *
 * @param {Array<{ engine: string, sources: Array<unknown> }>} answered engines that returned rows
 * @param {Array<{ engine: string, status: string, reason?: string }>} outcomes every engine outcome
 * @param {Record<string, number>} perEngine fused row counts per engine
 * @returns {string} summary line
 */
function summary(answered, outcomes, perEngine) {
  const parts = answered.map((outcome) => `${outcome.engine} ${perEngine[outcome.engine] ?? 0}`)
  const skipped = outcomes
    .filter((outcome) => outcome.status !== 'ok')
    .map((outcome) => `${outcome.engine} ${outcome.status === 'decoy' ? 'decoy' : outcome.status === 'benched' ? 'benched' : 'unavailable'}`)
  const suffix = skipped.length === 0 ? '' : ` · skipped: ${skipped.join(', ')}`
  return `Engines: ${parts.join(' · ')}${suffix}`
}
