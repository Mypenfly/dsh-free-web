/**
 * Sogou — the third mainland-China engine, and the only one here that needs a
 * pre-step.
 *
 * Its result anchors point at a session-bound `/link?url=` token that 302s back to
 * Sogou's homepage even with cookies and a referer, so the destination is read from
 * the hidden sibling `div.r-sech.ext_query[data-url]` inside the same result block.
 * The `citeLinkClass` display URL is truncated (`https://www.jb51.net/a...`) and is
 * never emitted.
 *
 * Without a session cookie the first hit arrives on a bare page, so one cheap GET
 * to `sogou.com/` mints the cookie jar; it is cached for the process lifetime.
 */

import { getText } from '../../util/http.mjs'
import { decodeEntities, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize } from '../../util/url.mjs'
import { detectGate } from '../gates.mjs'
import { parseDate } from '../../util/dates.mjs'

export const id = 'sogou'
export const label = 'Sogou'

/** Process-lifetime cookie jar: Sogou's anti-bot is per-session, not per-query. */
let cookieJar
let cookieExpiresAt = 0
/** Cookie TTL; refreshed lazily so one long session keeps working. */
const COOKIE_TTL_MS = 30 * 60 * 1000

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @param {{ fresh?: string }} [options] search options
 * @returns {string} absolute URL
 */
export function buildUrl(query, options = {}) {
  const url = new URL('https://www.sogou.com/web')
  url.searchParams.set('query', query)
  if (options.fresh !== undefined) {
    // Sogou's `tsn` is a relative-window code; unsupported values are skipped
    // rather than silently mis-filtering.
    const map = { day: '1', week: '2', month: '3', year: '4' }
    const token = map[options.fresh]
    if (token !== undefined) url.searchParams.set('tsn', token)
  }
  return url.toString()
}

/**
 * Extract sources from a Sogou result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/<div class="vrwrap"/).slice(1)) {
    const body = block.slice(0, block.indexOf('</div>') === -1 ? 6000 : 6000)
    const heading = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)
    if (heading === null) continue
    const dataUrl = body.match(/data-url="(https?:\/\/[^"]+)"/)
    let target = dataUrl === null ? undefined : decodeEntities(dataUrl[1])
    if (target === undefined) {
      const href = firstHref(heading[1])
      if (href !== undefined) {
        const absolute = absolutize(decodeEntities(href), pageUrl)
        // Token redirects cannot be resolved without the live session; skip them
        // rather than cite a Sogou URL as the destination.
        if (!/sogou\.com\/link\?/i.test(absolute)) target = absolute
      }
    }
    if (target === undefined || !/^https?:\/\//i.test(target)) continue
    if (/^https?:\/\/([a-z0-9-]+\.)*sogou\.com\//i.test(target)) continue
    const title = htmlToText(heading[1])
    const snippetBlock =
      body.match(/<div[^>]*class="[^"]*fz-mid[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
      body.match(/<div[^>]*class="[^"]*cacheresult_summary[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
      body.match(/<p[^>]*class="[^"]*star-wiki[^"]*"[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snippetBlock === null ? undefined : htmlToText(snippetBlock[1])
    const dateMatch = body.match(/class="citeLinkClass"[^>]*>([\s\S]*?)<\/a>/)
    const publishedAt = dateMatch === null ? undefined : parseDate(htmlToText(dateMatch[1]))
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
 * Mint (or reuse) the Sogou session cookie.
 * @param {{ signal?: AbortSignal, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<string | undefined>} `Cookie` header value
 */
async function sessionCookie(options) {
  if (cookieJar !== undefined && Date.now() < cookieExpiresAt) return cookieJar
  const page = await getText('https://www.sogou.com/', {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    label: 'sogou',
  })
  const cookies = page.cookies ?? []
  if (cookies.length === 0) return undefined
  cookieJar = cookies.map((cookie) => cookie.split(';')[0]).join('; ')
  cookieExpiresAt = Date.now() + COOKIE_TTL_MS
  return cookieJar
}

/**
 * Run one Sogou search.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, fresh?: string, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>>} sources
 */
export async function search(query, options) {
  const cookie = await sessionCookie(options).catch(() => undefined)
  const pageUrl = buildUrl(query, options)
  const page = await getText(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://www.sogou.com/',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
    label: 'sogou',
  })
  if (page.status === 429) throw new Error('sogou rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`sogou answered HTTP ${page.status}`)
  const gate = detectGate(page.text)
  if (gate !== null) throw new Error(`sogou served a ${gate} page`)
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('sogou returned no results with a direct destination')
  return sources
}

/** Reset the cached cookie jar (used by tests and after a gate hit). */
export function resetSession() {
  cookieJar = undefined
  cookieExpiresAt = 0
}
