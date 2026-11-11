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
 * The transport is the plugin's own (`util/transport.mjs`), so the public-destination
 * check is not a pre-flight guess any more: every hop resolves the name, refuses a
 * non-public answer, and pins the verified address into the socket. Behind a proxy
 * the name is resolved by the proxy, so the same check runs before the tunnel is
 * opened — the fetch cannot be steered into the local network either way.
 */

import { isIP } from 'node:net'
import { FreeWebError, abortedError, providerError } from '../util/errors.mjs'
import { deadline, isAbortError, throwIfAborted } from '../util/http.mjs'
import { isLoopbackName, isNonPublicAddress } from '../util/address.mjs'
import { readCappedText, request } from '../util/transport.mjs'
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
 * Lives in `util/address.mjs` because the transport needs the same answer for
 * every hop; re-exported here so the provider remains the policy's public face.
 */
export { isNonPublicAddress }

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
  if (isLoopbackName(host)) {
    throw new FreeWebError(`"${host}" resolves to the loopback interface`, 'WEB_BLOCKED_URL')
  }
  return url
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
   * @param {{ url: string }} seamRequest seam request
   * @param {AbortSignal} [signal] cancellation
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async fetch(seamRequest, signal) {
    throwIfAborted(signal)
    const budget = deadline(signal, this.timeoutMs)
    try {
      return await this.#follow(validateUrl(seamRequest.url), budget.signal)
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
   *
   * Redirects stay manual here: the transport does one hop, this loop decides
   * whether the next hop is allowed (same origin, validated URL, public address).
   *
   * @param {URL} initial validated URL
   * @param {AbortSignal} signal combined budget signal
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async #follow(initial, signal) {
    let current = initial
    for (let hop = 0; ; hop += 1) {
      let response
      try {
        response = await request(current, {
          method: 'GET',
          signal,
          publicOnly: true,
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,*/*;q=0.5',
            'accept-language': 'en-US,en;q=0.9',
          },
        })
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortedError('web fetch aborted', error)
        throw error
      }

      if (response.status >= 300 && response.status < 400) {
        response.stream?.destroy()
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
   * @param {{ ok: boolean, status: number, headers: import('../util/transport.mjs').ResponseHeaders, stream: import('node:stream').Readable }} response final response
   * @param {URL} finalUrl the URL that produced it
   * @param {AbortSignal} signal budget signal
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async #read(response, finalUrl, signal) {
    const contentType = response.headers.get('content-type')
    const kind = classify(contentType)
    if (kind === undefined && response.ok) {
      response.stream?.destroy()
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
