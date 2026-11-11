/**
 * URL normalization for citation quality: unwrap engine redirects, drop tracking
 * parameters, and collapse duplicates that differ only by noise.
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'igshid', 'spm', 'scm', 'ref', 'ref_src',
  'mc_cid', 'mc_eid', '_ga', 'amp',
])

/** Hosts that only wrap the real destination in a parameter. */
const REDIRECT_HOSTS = [
  // DuckDuckGo
  ['duckduckgo.com', 'uddg'],
  // Yahoo (US/JP) interstitial
  ['r.search.yahoo.com', 'RU'],
  // Bing
  ['bing.com', 'u'],
  // Sogou
  ['sogou.com', 'url'],
  // Baidu
  ['baidu.com', 'url'],
]

/**
 * Base64url decode, tolerating padding (`-`/`_` alphabet or standard `+/`).
 * @param {string} input encoded text
 * @returns {string | undefined} decoded UTF-8 text
 */
function decodeBase64Url(input) {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Unwrap one engine redirector into its destination.
 *
 * @param {string} raw href as written by the engine
 * @param {string} [engine] engine id, when the href is site-relative
 * @returns {string | undefined} absolute destination, or undefined when the value
 *   carries no recoverable destination (Baidu's opaque `link?url=` tokens are
 *   such a case and are resolved by an extra HEAD request instead)
 */
export function unwrapRedirect(raw, engine) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  for (const [host, param] of REDIRECT_HOSTS) {
    if (!url.hostname.endsWith(host)) continue
    const value = url.searchParams.get(param)
    if (value === null || value.length === 0) continue
    if (param === 'u') {
      // Bing: `u=a1<base64url>`; the `a1` prefix marks an encoded absolute URL.
      const decoded = value.startsWith('a1') ? decodeBase64Url(value.slice(2)) : undefined
      if (decoded !== undefined && /^https?:\/\//i.test(decoded)) return decoded
      continue
    }
    if (param === 'RU') {
      if (value.startsWith('/')) continue
      if (/^https?:\/\//i.test(value)) return value
      continue
    }
    if (param === 'url') {
      // Sogou wraps absolute URLs directly; Baidu uses opaque tokens.
      if (/^https?:\/\//i.test(value)) return value
      if (engine === 'baidu') return undefined
      continue
    }
    if (/^https?:\/\//i.test(value)) return value
  }
  // DuckDuckGo's lite endpoint writes protocol-relative targets too.
  return undefined
}

/**
 * Normalize a URL for display and dedupe.
 *
 * @param {string} raw absolute URL (redirects already unwrapped)
 * @returns {string | undefined} canonical form, or undefined when unusable
 */
export function canonicalUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
  }
  url.hostname = url.hostname.replace(/^www\./, '')
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = ''
  }
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
  if (url.pathname === '/' && url.search === '') return url.origin
  return url.toString()
}

/**
 * Dedupe key: canonical URL without the scheme, plus the path only.
 *
 * `http`/`https` twins and `www`/bare hosts of the same page collapse here; the
 * cited URL is the first canonical form encountered.
 *
 * @param {string} canonical canonical URL
 * @returns {string} dedupe key
 */
export function dedupeKey(canonical) {
  try {
    const url = new URL(canonical)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch {
    return canonical
  }
}

/**
 * Hostname for display, used when an engine returns no title.
 * @param {string} raw URL
 * @returns {string} host without `www.`
 */
export function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return raw
  }
}

/**
 * Resolve a possibly site-relative href against the engine page URL.
 * @param {string} href raw href
 * @param {string} base engine page URL
 * @returns {string} absolute URL
 */
export function absolutize(href, base) {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
