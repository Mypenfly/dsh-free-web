/**
 * Baidu — worth having for Chinese-language queries, fragile everywhere else.
 *
 * Baidu gates hard (a `百度安全验证` interstitial is common through shared proxy
 * IPs) and links results through an opaque `link?url=` token that costs one extra
 * request per hit to resolve. This engine therefore only emits a source when the
 * result container carries the real destination inline (`mu` / `data-landurl`);
 * anything else is dropped rather than cited as a Baidu redirector, and the
 * provider benches the engine on the first CAPTCHA.
 *
 * Off by default; enable with `engines: [..., 'baidu']`.
 */

import { getTextRetrying } from '../../util/http.mjs'
import { decodeEntities, firstAttribute, firstHref, htmlToText } from '../../util/html.mjs'
import { absolutize } from '../../util/url.mjs'

export const id = 'baidu'
export const label = 'Baidu'

/**
 * Build the result-page URL for one query.
 * @param {string} query user query
 * @returns {string} absolute URL
 */
export function buildUrl(query) {
  const url = new URL('https://www.baidu.com/s')
  url.searchParams.set('wd', query)
  url.searchParams.set('rn', '20')
  return url.toString()
}

/**
 * Extract sources from a Baidu result page.
 * @param {string} html page source
 * @param {string} pageUrl the URL that produced this page
 * @returns {Array<{ url: string, title?: string, snippet?: string }>}
 */
export function extract(html, pageUrl) {
  const sources = []
  for (const block of html.split(/<div[^>]*class="result[^"]*"/).slice(1)) {
    const openTag = block.slice(0, block.indexOf('>'))
    const slice = block.slice(0, 4000)
    const direct = firstAttribute(openTag, 'mu') ?? firstAttribute(openTag, 'data-landurl')
    let target =
      direct !== undefined && /^https?:\/\//i.test(direct)
        ? decodeEntities(direct)
        : undefined
    if (target === undefined) {
      // Baidu sometimes embeds the destination on the title anchor instead.
      const anchor = slice.match(/<a\b[^>]*>/i)?.[0] ?? ''
      const embedded = firstAttribute(anchor, 'mu') ?? firstAttribute(anchor, 'data-landurl')
      if (embedded !== undefined && /^https?:\/\//i.test(embedded)) target = decodeEntities(embedded)
    }
    if (target === undefined) {
      const href = firstHref(slice)
      if (href !== undefined) {
        const absolute = absolutize(decodeEntities(href), pageUrl)
        // Opaque token redirects are not citable; only real destinations pass.
        if (!/baidu\.com\/link\?/i.test(absolute)) target = absolute
      }
    }
    if (target === undefined || !/^https?:\/\//i.test(target)) continue
    const heading = slice.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)
    const title = heading === null ? '' : htmlToText(heading[1])
    const snippetMatch =
      slice.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
      slice.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/)
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
 * Run one Baidu search.
 * @param {string} query user query
 * @param {{ signal?: AbortSignal, timeoutMs: number, acceptLanguage: string }} options
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string }>>} sources
 */
export async function search(query, options) {
  const pageUrl = buildUrl(query)
  const page = await getTextRetrying(pageUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    acceptLanguage: options.acceptLanguage,
    referer: 'https://www.baidu.com/',
    label: 'baidu',
  })
  if (page.status === 429) throw new Error('baidu rate limited (HTTP 429)')
  if (page.status >= 400) throw new Error(`baidu answered HTTP ${page.status}`)
  if (page.text.includes('百度安全验证') || page.text.includes('安全验证')) {
    throw new Error('baidu served a verification page')
  }
  const sources = extract(page.text, pageUrl)
  if (sources.length === 0) throw new Error('baidu returned no results with a direct destination')
  return sources
}
