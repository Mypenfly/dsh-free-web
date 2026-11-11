/**
 * The free fetch provider registered into the host's `ctx.web` seam.
 *
 * What it adds over the shipped `dsh-web-fetch-http` provider: the body it hands
 * back is the *article*, not the whole document (see `reader.mjs`), so the model
 * stops paying for navigation, cookie banners, and related-links rails.
 *
 * What it deliberately keeps identical:
 *  - only `http:`/`https:` URLs, public destinations only (loopback, private,
 *    link-local, CGNAT, and multicast are refused before any request);
 *  - redirects are followed only within the same origin, up to the same hop cap,
 *    each hop re-validated;
 *  - the same failure codes (`WEB_INVALID_URL`, `WEB_BLOCKED_URL`,
 *    `WEB_REDIRECT_BLOCKED`, `WEB_FETCH_TOO_LARGE`, `WEB_UNSUPPORTED_CONTENT_TYPE`,
 *    `WEB_FETCH_TIMEOUT`, `WEB_ABORTED`).
 *
 * Known gap: the transport is the host's global `fetch`, because that is the only
 * HTTP client wired to the host's proxy dispatcher — and without the proxy this
 * machine cannot reach the public web at all. A custom `lookup` (DNS pinning,
 * which the shipped provider does) is therefore unavailable; the pre-flight
 * resolution check below closes the literal-IP and plain-hostname cases but not a
 * rebinding race. Anything stricter than "don't fetch my LAN" is out of scope for
 * a plugin.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { FreeWebError, abortedError, providerError } from '../util/errors.mjs'
import { deadline, isAbortError, readCappedText, throwIfAborted } from '../util/http.mjs'
import { extractReadable } from './reader.mjs'

/** Limits mirroring the shipped provider's defaults. */
export const LIMITS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  maxUrlLength: 2048,
}

/** Content types this provider can turn into text. */
const TEXTUAL = [
  /^text\//i,
  /^application\/(?:json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|javascript|x-ndjson)/i,
  /^application\/(?:x-)?(?:yaml|x-yaml)/i,
  /^image\/svg\+xml/i,
]

/**
 * Classify a content type as `html`, `text`, or `unsupported`.
 * @param {string | null} contentType response header
 * @returns {'html' | 'text' | undefined} body kind
 */
export function classify(contentType) {
  if (contentType === null) return undefined
  if (/^text\/html/i.test(contentType) || /^application\/xhtml\+xml/i.test(contentType)) return 'html'
  return TEXTUAL.some((pattern) => pattern.test(contentType)) ? 'text' : undefined
}

/**
 * True when an IP literal is a destination this provider must refuse.
 *
 * @param {string} address IPv4 or IPv6 literal
 * @returns {boolean} true for non-public addresses
 */
export function isNonPublicAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    if (a === 192 && b === 0) return true
    return false
  }
  if (family === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    if (mapped !== null) return isNonPublicAddress(mapped[1])
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
    if (mappedHex !== null) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      return isNonPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return false
  }
  return false
}

/**
 * Validate one URL before any request is made.
 * @param {string} raw URL from the model
 * @returns {URL} parsed URL
 */
export function validateUrl(raw) {
  if (raw.length > LIMITS.maxUrlLength) {
    throw new FreeWebError(`URL exceeds ${LIMITS.maxUrlLength} characters`, 'WEB_FETCH_MAX_URL_LENGTH')
  }
  let url
  try {
    url = new URL(raw)
  } catch (error) {
    throw new FreeWebError(`not a valid absolute URL: ${raw}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FreeWebError(`only http and https URLs can be fetched, got "${url.protocol}"`, 'WEB_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new FreeWebError('URLs with embedded credentials are not fetched', 'WEB_INVALID_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 && isNonPublicAddress(host)) {
    throw new FreeWebError(`"${host}" is not a public address`, 'WEB_BLOCKED_URL')
  }
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new FreeWebError(`"${host}" resolves to the loopback interface`, 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Refuse a hostname whose every DNS answer is non-public.
 *
 * A hostname with a mixed answer set is refused outright: pinning one address is
 * not available here, so a partial answer cannot be made safe.
 *
 * @param {URL} url validated URL
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<void>} resolves when the destination is public
 */
async function assertPublicHost(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return
  let addresses
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw providerError(`could not resolve "${host}": ${error instanceof Error ? error.message : String(error)}`, error)
  }
  throwIfAborted(signal)
  if (addresses.length === 0) throw new FreeWebError(`"${host}" resolved to no addresses`, 'WEB_BLOCKED_URL')
  for (const entry of addresses) {
    if (isNonPublicAddress(entry.address)) {
      throw new FreeWebError(`"${host}" resolves to the non-public address ${entry.address}`, 'WEB_BLOCKED_URL')
    }
  }
}

/** The fetch provider. */
export class FreeFetchProvider {
  /** @type {string} */
  id

  /**
   * @param {object} options
   * @param {string} options.id provider id registered with the seam
   * @param {number} [options.timeoutMs] total budget for one fetch
   * @param {number} [options.maxBodyChars] cap on returned characters
   * @param {number} [options.maxResponseBytes] cap on downloaded bytes
   * @param {string} [options.userAgent] UA header
   * @param {(message: string, detail?: unknown) => void} [options.log] diagnostics sink
   */
  constructor(options) {
    this.id = options.id
    this.timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs
    this.maxBodyChars = options.maxBodyChars ?? LIMITS.maxBodyChars
    this.maxResponseBytes = options.maxResponseBytes ?? LIMITS.maxResponseBytes
    this.userAgent = options.userAgent ?? 'Mozilla/5.0 (compatible; dsh-free-web/0.1)'
    this.log = options.log ?? (() => {})
  }

  /** Anonymous fetcher: always usable. */
  available() {
    return true
  }

  /**
   * Retrieve one URL and return its readable body.
   * @param {{ url: string }} request seam request
   * @param {AbortSignal} [signal] cancellation
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async fetch(request, signal) {
    throwIfAborted(signal)
    const budget = deadline(signal, this.timeoutMs)
    try {
      return await this.#follow(validateUrl(request.url), budget.signal)
    } catch (error) {
      if (budget.timedOut()) {
        throw new FreeWebError(`fetch timed out after ${this.timeoutMs}ms`, 'WEB_FETCH_TIMEOUT', { cause: error })
      }
      if (signal?.aborted === true || isAbortError(error)) throw abortedError('web fetch aborted', error)
      throw error
    } finally {
      budget.done()
    }
  }

  /**
   * Follow same-origin redirects, then read the final body.
   * @param {URL} initial validated URL
   * @param {AbortSignal} signal combined budget signal
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async #follow(initial, signal) {
    let current = initial
    for (let hop = 0; ; hop += 1) {
      await assertPublicHost(current, signal)
      let response
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,*/*;q=0.5',
            'accept-language': 'en-US,en;q=0.9',
          },
        })
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortedError('web fetch aborted', error)
        throw providerError(`request to ${current.toString()} failed: ${error instanceof Error ? error.message : String(error)}`, error)
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        if (hop >= LIMITS.maxRedirects) {
          throw new FreeWebError(`exceeded the maximum of ${LIMITS.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) throw providerError(`redirect response (HTTP ${response.status}) without a Location header`)
        let target
        try {
          target = new URL(location, current)
        } catch (error) {
          throw new FreeWebError(`redirect Location "${location}" is not a URL`, 'WEB_REDIRECT_BLOCKED', { cause: error })
        }
        if (target.origin !== current.origin) {
          throw new FreeWebError(
            `cross-origin redirect to ${target.origin} is not followed automatically; call web_fetch with that URL directly`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        const validated = validateUrl(target.toString())
        current = validated
        continue
      }

      return await this.#read(response, current, signal)
    }
  }

  /**
   * Read, cap, classify, and extract one response.
   * @param {Response} response final response
   * @param {URL} finalUrl the URL that produced it
   * @param {AbortSignal} signal budget signal
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async #read(response, finalUrl, signal) {
    const contentType = response.headers.get('content-type')
    const kind = classify(contentType)
    if (kind === undefined && response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new FreeWebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const { text, truncated: bytesTruncated } = await readCappedText(response, this.maxResponseBytes)
    throwIfAborted(signal)
    const extracted = kind === 'html' ? extractAsText(text) : text
    const truncatedByChars = extracted.length > this.maxBodyChars
    const content = truncatedByChars ? extracted.slice(0, this.maxBodyChars) : extracted
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body: { kind: 'text', content },
      truncated: bytesTruncated || truncatedByChars,
    }
  }
}

/**
 * Reader extraction with a whole-document fallback.
 *
 * Some pages put the content in JS-rendered shells where no region scores; falling
 * back to the stripped document beats returning an empty body.
 *
 * @param {string} html source
 * @returns {string} readable text
 */
function extractAsText(html) {
  const readable = extractReadable(html)
  if (readable.text.length >= 200) return readable.text
  const fallback = extractReadable(html.replace(/<\/?(?:article|main|section|div)\b[^>]*>/gi, '\n')).text
  return fallback.length > readable.text.length ? fallback : readable.text
}
