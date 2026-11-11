/**
 * 360 Search (`so.com`) — the dependable mainland-China engine for CJK queries.
 *
 * Its result anchors carry `data-mdurl` with the destination alongside the
 * `so.com/link?m=...` redirector, so citing never needs an extra hop. Snippets
 * live in `p.res-desc`, whose leading `gray` span holds the publication date.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstAttribute, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize, unwrapRedirect } from '../../util/url.mjs'
import { detectGate } from '../gates.mjs'
import { parseDate } from '../../util/dates.mjs'

export const id = 'so360'
export const label = '360 Search'

/** `adv_t=` codes for the four freshness windows. */
const FRESHNESS = { day: 'd', week: 'w', month: 'm', year: 'y' }

/** 360's own properties leak into `data-mdurl`; none of them is a citation. */
const OWN_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*(so\.com|360\.com|360kan\.com|qhimg\.com)\//i

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string, count?: number }} [options] search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://www.so.com/s')
  url.searchParams.set('q', query)
  url.searchParams.set('rn', String(Math.min(Math.max(options.count ?? 10, 10), 50)))
  if (options.fresh !== undefined && FRESHNESS[options.fresh] !== undefined) {
    url.searchParams.set('adv_t', FRESHNESS[options.fresh])
  }
  return url.toString()
}

/**
 * Extract sources from a 360 Search result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/<li class="res-list"/).slice(1)) {
    const body = block.slice(0, block.indexOf('</li>') === -1 ? 4000 : block.indexOf('</li>'))
    const heading = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)
    if (heading === null) continue
    const anchor = heading[1].match(/<a\b[^>]*>/i)?.[0]
    if (anchor === undefined) continue
    const direct = firstAttribute(anchor, 'data-mdurl')
    const href = firstHref(heading[1])
    const candidate =
      direct !== undefined && /^https?:\/\//i.test(direct)
        ? decodeEntities(direct)
        : href === undefined
          ? undefined
          : unwrapRedirect(absolutize(decodeEntities(href), pageUrl), 'so360')
    if (candidate === undefined || !/^https?:\/\//i.test(candidate)) continue
    if (OWN_HOSTS.test(candidate)) continue
    const title = htmlToText(heading[1])
    const snippetBlock = body.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/)
    const dateMatch = body.match(/<span class="[^"]*gray[^"]*"[^>]*>([^<]*)<\/span>/)
    const publishedAt = dateMatch === null ? undefined : parseDate(dateMatch[1])
    const snippet =
      snippetBlock === null ? undefined : htmlToText(snippetBlock[1].replace(/<span class="[^"]*gray[^"]*"[^>]*>[^<]*<\/span>/, ''))
    sources.push({
      url: candidate,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * Run one 360 Search query.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>>} sources
 */
export async function search(query, options) {
  const pageUrl = buildUrl(query, options)
  const page = await getTextRetrying(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://www.so.com/',
    label: 'so360',
  })
  if (page.status === 429) throw new Error('so360 rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`so360 answered HTTP ${page.status}`)
  const gate = detectGate(page.text)
  if (gate !== null) throw new Error(`so360 served a ${gate} page`)
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('so360 returned no parsable result items')
  return sources
}
