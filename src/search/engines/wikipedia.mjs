/**
 * Wikipedia — the only engine here backed by a documented, keyless JSON API, so it
 * never gets benched. It answers encyclopedic queries well and stays quiet (no
 * results) for everything else, which is exactly the behaviour a supplementary
 * engine should have.
 *
 * Language follows the query script: CJK queries search zh.wikipedia, everything
 * else en.wikipedia.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { htmlToText } from '../../util/html.mjs'

export const id = 'wikipedia'
export const label = 'Wikipedia'

/** CJK ranges that make a zh.wikipedia lookup more useful than en. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Pick the wiki language for one query.
 * @param {string} query user query
 * @returns {string} wiki language code
 */
export function languageFor(query) {
  return CJK.test(query) ? 'zh' : 'en'
}

/**
 * Build the MediaWiki search API URL for one query.
 * @param {string} query user query
 * @param {number} count result cap
 * @returns {string} absolute URL
 */
export function buildUrl(query, count) {
  const language = languageFor(query)
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`)
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(count))
  url.searchParams.set('srprop', 'snippet|timestamp')
  url.searchParams.set('format', 'json')
  url.searchParams.set('utf8', '1')
  return url.toString()
}

/**
 * Map a MediaWiki search payload to sources.
 * @param {unknown} payload parsed JSON
 * @param {string} language wiki language code
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>} sources
 */
export function extract(payload, language) {
  const hits = /** @type {{ query?: { search?: Array<{ title?: string, snippet?: string, timestamp?: string }> } }} */ (
    payload
  )?.query?.search
  if (!Array.isArray(hits)) return []
  const sources = []
  for (const hit of hits) {
    if (typeof hit.title !== 'string' || hit.title.length === 0) continue
    const snippet = typeof hit.snippet === 'string' ? htmlToText(hit.snippet) : undefined
    const publishedAt = typeof hit.timestamp === 'string' ? hit.timestamp.slice(0, 10) : undefined
    sources.push({
      url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replaceAll(' ', '_'))}`,
      title: hit.title,
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * Run one Wikipedia lookup.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, count?: number, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>>} sources
 */
export async function search(query, options) {
  const language = languageFor(query)
  const page = await getTextRetrying(buildUrl(query, Math.max(3, options.count ?? 5)), {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    headers: { accept: 'application/json' },
    label: 'wikipedia',
  })
  if (page.status >= 400) throw new Error(`wikipedia answered HTTP ${page.status}`)
  let payload
  try {
    payload = JSON.parse(page.text)
  } catch {
    throw new Error('wikipedia returned a non-JSON body')
  }
  const sources = extract(payload, language)
  if (sources.length === 0) throw new Error('wikipedia found no matching articles')
  return sources
}
