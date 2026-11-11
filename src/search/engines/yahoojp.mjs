/**
 * Yahoo! JAPAN web search — the keyless route to a Google-class index.
 *
 * The result page is a Next.js render but the result cards themselves are plain
 * server HTML: `div.sw-Card.Algo` sections with the destination URL already
 * absolute in `a.sw-Card__titleInner`. No redirect unwrapping is needed, which is
 * why this engine is one of the dependable two.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize } from '../../util/url.mjs'
import { detectGate } from '../gates.mjs'

export const id = 'yahoojp'
export const label = 'Yahoo! JAPAN'

/** Yahoo's own hosts that must never be cited as a result. */
const OWN_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*(yahoo\.co\.jp|yimg\.jp|yahoo\.com)\//i

/** `vd=` codes for the four freshness windows. `m` is NOT valid and silently
 * returns the unfiltered ranking; month is `m1`. */
const FRESHNESS = { day: 'd', week: 'w', month: 'm1', year: 'y' }

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string }} [options] search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://search.yahoo.co.jp/search')
  url.searchParams.set('p', query)
  url.searchParams.set('ei', 'UTF-8')
  if (options.fresh !== undefined && FRESHNESS[options.fresh] !== undefined) {
    url.searchParams.set('vd', FRESHNESS[options.fresh])
  }
  return url.toString()
}

/**
 * Extract sources from a Yahoo! JAPAN result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  // The literal attribute marks result cards; the stylesheet mentions the class
  // hierarchy but never this exact attribute value.
  const cards = html.split(/<div class="sw-Card[^"]*\bAlgo\b[^"]*">/).slice(1)
  for (const card of cards) {
    const titleBlock = card.match(/<div class="sw-Card__title">([\s\S]*?)<\/div>/)
    if (titleBlock === null) continue
    const href = firstHref(titleBlock[1], OWN_HOSTS)
    if (href === undefined) continue
    const target = absolutize(decodeEntities(href), pageUrl)
    if (OWN_HOSTS.test(target)) continue
    // The anchor text is `site › breadcrumb › title`; the h3 holds the title alone.
    const heading = titleBlock[1].match(/<h3[^>]*>([\s\S]*?)<\/h3>/)
    const title = htmlToText(heading === null ? titleBlock[1] : heading[1])
    const summary =
      card.match(/<p class="sw-Card__summary"[^>]*>([\s\S]*?)<\/p>/) ??
      card.match(/<div class="sw-Card__summary"[^>]*>([\s\S]*?)<\/div>/) ??
      card.match(/<p class="[^"]*sw-Card__richText[^"]*"[^>]*>([\s\S]*?)<\/p>/)
    const snippet = summary === null || summary === undefined ? undefined : htmlToText(summary[1])
    sources.push({
      url: target,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return sources
}

/**
 * Run one Yahoo! JAPAN search.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string }>>} sources
 */
export async function search(query, options) {
  const pageUrl = buildUrl(query, options)
  const page = await getTextRetrying(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://search.yahoo.co.jp/',
    label: 'yahoojp',
  })
  if (page.status === 429) throw new Error('yahoojp rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`yahoojp answered HTTP ${page.status}`)
  const gate = detectGate(page.text)
  if (gate !== null) throw new Error(`yahoojp served a ${gate} page`)
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('yahoojp returned no parsable result cards')
  return sources
}
