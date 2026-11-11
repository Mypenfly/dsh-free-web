/**
 * Brave Search — richest snippets of the keyless engines, and the most willing to
 * answer a proxy/shared IP with HTTP 429. Kept in the pool with the provider's
 * breaker as its guard: when Brave benches itself the other engines answer alone.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize } from '../../util/url.mjs'

export const id = 'brave'
export const label = 'Brave Search'

/** Brave's own assets and interstitials are never citations. */
const OWN_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*(brave\.com|search\.brave\.com|imgs\.search\.brave\.com)\//i

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string }} [options] search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://search.brave.com/search')
  url.searchParams.set('q', query)
  url.searchParams.set('source', 'web')
  if (options.fresh !== undefined) url.searchParams.set('tf', options.fresh)
  return url.toString()
}

/**
 * Extract sources from a Brave result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/data-type="web"/).slice(1)) {
    const slice = block.slice(0, 6000)
    const href = firstHref(slice, OWN_HOSTS)
    if (href === undefined) continue
    const target = absolutize(decodeEntities(href), pageUrl)
    if (OWN_HOSTS.test(target)) continue
    const titleMatch = slice.match(/<div class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const title = titleMatch === null ? '' : htmlToText(titleMatch[1])
    const snippetMatch =
      slice.match(/<div class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
      slice.match(/<div class="snippet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = snippetMatch === null ? undefined : htmlToText(snippetMatch[1])
    sources.push({
      url: target,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return sources
}

/**
 * Run one Brave search.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, fresh?: string, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string }>>} sources
 */
export async function search(query, options) {
  const pageUrl = buildUrl(query, options)
  const page = await getTextRetrying(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://search.brave.com/',
    label: 'brave',
  })
  if (page.status === 429) throw new Error('brave rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`brave answered HTTP ${page.status}`)
  if (page.text.includes('not a robot') || page.text.includes('Security settings')) {
    throw new Error('brave served a bot check')
  }
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('brave returned no parsable results')
  return sources
}
