/**
 * Result fusion: Reciprocal Rank Fusion over per-engine rankings, then canonical
 * dedupe.
 *
 * RRF is the right merge for heterogeneous engines because their scores are not
 * comparable (Bing has no score, 360's is a page rank, Wikipedia ranks by term
 * frequency). Rank position is the only shared signal, so a source pays
 * `1 / (k + rank)` per engine that returned it and rises when engines agree.
 */

import { canonicalUrl, dedupeKey } from '../util/url.mjs'

/** RRF damping constant; 60 is the value from the original TREC paper. */
export const RRF_K = 60

/**
 * Fuse per-engine rankings into one order.
 *
 * @param {Array<{ engine: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }> }>} rankings
 * @param {{ k?: number, limit?: number }} [options] damping constant and cap
 * @returns {{ sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, perEngine: Record<string, number>, total: number }}
 *   merged sources (best first), per-engine source counts, and the pre-cap total
 */
export function fuse(rankings, options = {}) {
  const k = options.k ?? RRF_K
  /** @type {Map<string, { source: { url: string, title?: string, snippet?: string, publishedAt?: string }, score: number, engines: string[] }>} */
  const merged = new Map()
  const perEngine = {}
  for (const ranking of rankings) {
    perEngine[ranking.engine] = ranking.sources.length
    ranking.sources.forEach((source, index) => {
      const canonical = canonicalUrl(source.url)
      if (canonical === undefined) return
      const key = dedupeKey(canonical)
      const score = 1 / (k + index + 1)
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, { source: { ...source, url: canonical }, score, engines: [ranking.engine] })
        return
      }
      existing.score += score
      existing.engines.push(ranking.engine)
      // Keep the first non-empty title/snippet/date: earlier engines are the more
      // trusted ones in the configured order and their text is what the model
      // would have seen anyway.
      existing.source.title ??= source.title
      existing.source.snippet ??= source.snippet
      existing.source.publishedAt ??= source.publishedAt
    })
  }
  const ordered = [...merged.values()].sort((a, b) => b.score - a.score).map((entry) => entry.source)
  const limit = options.limit
  return {
    sources: limit === undefined ? ordered : ordered.slice(0, limit),
    perEngine,
    total: ordered.length,
  }
}
