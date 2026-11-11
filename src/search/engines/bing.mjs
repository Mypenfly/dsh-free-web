/**
 * Bing, via the result page with the RSS feed as a fallback route.
 *
 * The HTML page carries the richest snippets but intermittently answers with a
 * result-list-less shell (the `b_algo` container absent) depending on cookies and
 * region. The `/search?format=rss` feed answers from the same index and is
 * structured, so one engine covers both: HTML first, RSS when the HTML yielded
 * nothing usable.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize, unwrapRedirect } from '../../util/url.mjs'
import { detectGate } from '../gates.mjs'
import { parseDate } from '../../util/dates.mjs'

export const id = 'bing'
export const label = 'Bing'

/** Bing `filters=ex1:"ezN"` codes for the four freshness windows we expose. */
const FRESHNESS = { day: 'ez1', week: 'ez2', month: 'ez3', year: 'ez5' }

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string, count?: number, market?: string }} options search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://www4.bing.com/search')
  url.searchParams.set('q', query)
  // `form=QBRE` is the full result layout; `form=QBLH` returns a lighter page with
  // no `.b_algo` at all. `count` is never sent: no browser sends it, and Bing
  // answers a count-bearing request with its decoy page.
  url.searchParams.set('form', 'QBRE')
  if (options.fresh !== undefined && FRESHNESS[options.fresh] !== undefined) {
    url.searchParams.set('filters', `ex1:"${FRESHNESS[options.fresh]}"`)
  }
  if (options.market !== undefined) url.searchParams.set('mkt', options.market)
  return url.toString()
}

/**
 * Extract sources from a Bing result page.
 *
 * Bing links results through `bing.com/ck/a?...u=a1<base64url>`, so the decode in
 * `unwrapRedirect` is what turns them into citable URLs.
 *
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const head = block.slice(0, block.indexOf('</li>') === -1 ? 4000 : block.indexOf('</li>'))
    const headingMatch = head.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    if (headingMatch === null) continue
    const href = firstHref(headingMatch[1])
    if (href === undefined) continue
    const absolute = absolutize(decodeEntities(href), pageUrl)
    const target = unwrapRedirect(absolute) ?? absolute
    if (!/^https?:\/\//i.test(target) || /(^|\.)bing\.com\//i.test(target)) continue
    const title = htmlToText(headingMatch[1])
    const snippetMatch =
      head.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
      head.match(/<p class="[^"]*b_paractl[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
      head.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snippetMatch === null || snippetMatch === undefined ? undefined : htmlToText(snippetMatch[1])
    const dateMatch = head.match(/<span class="news_dt"[^>]*>([^<]*)<\/span>/)
    const publishedAt = dateMatch === null ? undefined : parseDate(dateMatch[1])
    sources.push({
      url: target,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * Extract sources from the Bing RSS feed (`/search?format=rss`).
 * @param {string} xml feed body
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function extractRss(xml) {
  const sources = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1]
    const link = /<link>([\s\S]*?)<\/link>/.exec(item)?.[1]?.trim()
    if (link === undefined || !/^https?:\/\//i.test(link)) continue
    const title = htmlToText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '')
    const description = /<description>([\s\S]*?)<\/description>/.exec(item)?.[1]
    const snippet = description === undefined ? undefined : htmlToText(description)
    const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1]?.trim()
    const publishedAt = date === undefined ? undefined : parseDate(date)
    sources.push({
      url: decodeEntities(link),
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * Run one Bing search.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, fresh?: string, count?: number, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>>} sources
 */
export async function search(query, options) {
  const pageUrl = buildUrl(query, options)
  const page = await getTextRetrying(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://www.bing.com/',
    label: 'bing',
  })
  if (page.status === 429) throw new Error('bing rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`bing answered HTTP ${page.status}`)
  const gate = detectGate(page.text)
  if (gate !== null) throw new Error(`bing served a ${gate} page`)
  const fromHtml = extract(page.text, pageUrl)
  if (fromHtml.length > 0) return fromHtml

  const rssUrl = new URL('https://www4.bing.com/search')
  rssUrl.searchParams.set('q', query)
  rssUrl.searchParams.set('format', 'rss')
  if (options.market !== undefined) rssUrl.searchParams.set('mkt', options.market)
  const feed = await getTextRetrying(rssUrl.toString(), {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    label: 'bing-rss',
  })
  if (feed.status === 429) throw new Error('bing rss rate limited (HTTP 429)')
  if (feed.status >= 400) throw new Error(`bing rss answered HTTP ${feed.status}`)
  const fromRss = extractRss(feed.text)
  if (fromRss.length === 0) throw new Error('bing returned no results (html and rss both empty)')
  return fromRss
}
