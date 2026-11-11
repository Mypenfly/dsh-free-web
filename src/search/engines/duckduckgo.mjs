/**
 * DuckDuckGo (HTML endpoint) — works only when the request looks like a visit.
 *
 * The endpoint answers a bare 202 `anomaly-modal` CAPTCHA to a referer-less
 * request, which is what makes DDG look permanently blocked from a script. With
 * `referer: https://duckduckgo.com/` (and no cookie requirement) it returns the
 * normal result page. `lite.` stays blocked in that mode, so only `html.` is used.
 *
 * Result links are `//duckduckgo.com/l/?uddg=<once-percent-encoded>`; the query
 * parser has already decoded that value once, so it must not be decoded again —
 * `…/wiki/C%2B%2B` would otherwise turn into a URL that 404s.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize, unwrapRedirect } from '../../util/url.mjs'
import { detectGate } from '../gates.mjs'

export const id = 'duckduckgo'
export const label = 'DuckDuckGo'

/** `df=` codes for the four freshness windows. */
const FRESHNESS = { day: 'd', week: 'w', month: 'm', year: 'y' }

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string }} [options] search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  if (options.fresh !== undefined && FRESHNESS[options.fresh] !== undefined) {
    url.searchParams.set('df', FRESHNESS[options.fresh])
  }
  return url.toString()
}

/**
 * Extract sources from a DuckDuckGo result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/<h2 class="result__title">/).slice(1)) {
    const body = block.slice(0, 4000)
    const href = firstHref(body)
    if (href === undefined) continue
    const absolute = absolutize(decodeEntities(href), pageUrl)
    const target = unwrapRedirect(absolute) ?? absolute
    if (!/^https?:\/\//i.test(target)) continue
    if (/^https?:\/\/([a-z0-9-]+\.)*duckduckgo\.com\//i.test(target)) continue
    const titleMatch = body.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/)
    const title = titleMatch === null ? '' : htmlToText(titleMatch[1])
    const snippetMatch =
      body.match(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/) ??
      body.match(/<div\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/)
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
 * Run one DuckDuckGo search.
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
    // Required: without it the endpoint answers 202 + anomaly-modal.
    referer: 'https://duckduckgo.com/',
    label: 'duckduckgo',
  })
  if (page.status === 202) throw new Error('duckduckgo served its CAPTCHA (HTTP 202 anomaly-modal)')
  if (page.status === 429) throw new Error('duckduckgo rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`duckduckgo answered HTTP ${page.status}`)
  const gate = detectGate(page.text)
  if (gate !== null) throw new Error(`duckduckgo served a ${gate} page`)
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('duckduckgo returned no parsable results')
  return sources
}
