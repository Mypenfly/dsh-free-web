/**
 * HTTP access for the free providers.
 *
 * The transport itself lives in `transport.mjs` (Node core, env-proxy aware, DNS
 * pinned). This module is the provider-facing convenience layer on top of it: a
 * browser-ish header set (keyless engines reject obvious clients), a byte cap,
 * per-request timeouts, cancellation, and redirect following so the fetch provider
 * can validate every hop while the search engines just get a page.
 */

import { FreeWebError, abortedError, providerError } from './errors.mjs'
import { describeTransportFailure, readCappedText, request } from './transport.mjs'

/** Desktop Chrome UA; engines gate on a plausible browser string. */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Default per-request budget for one engine call. */
export const ENGINE_TIMEOUT_MS = 8000

/** Default page cap for the fetch provider. */
export const FETCH_MAX_BYTES = 8 * 1024 * 1024

/** Redirect hops the fetch provider will follow. */
export const MAX_REDIRECTS = 6

/** Throw the seam's cancellation error when the caller already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortedError('web request aborted', signal.reason)
}

/** True for an abort caused by the caller's signal, our deadline, or a socket. */
export function isAbortError(error) {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

/**
 * Combine cancellation with a deadline the way Node's `AbortSignal.any` does,
 * keeping the timer referenced until the request settles.
 *
 * @param {AbortSignal | undefined} signal caller cancellation
 * @param {number} timeoutMs request budget
 * @returns {{ signal: AbortSignal, done: () => void, timedOut: () => boolean }}
 */
export function deadline(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
    timedOut: () => timedOut,
  }
}

/**
 * True for the statuses a client follows.
 *
 * @param {number} status response status
 * @returns {boolean} true for 301/302/303/307/308
 */
export function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * GET one URL as text with engine-friendly headers.
 *
 * Redirects are followed here, one validated hop at a time, instead of inside the
 * transport: the fetch provider does its own origin checks and only needs a single
 * hop, while the engines expect the final page.
 *
 * @param {string | URL} url absolute URL
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {number} [options.timeoutMs] request budget
 * @param {string} [options.acceptLanguage] Accept-Language header
 * @param {Record<string, string>} [options.headers] extra headers
 * @param {string} [options.referer] Referer header
 * @param {'follow' | 'manual'} [options.redirect] redirect policy
 * @param {number} [options.maxRedirects] hop cap for `follow`
 * @param {number} [options.maxBytes] response cap
 * @param {boolean} [options.publicOnly] refuse non-public destinations
 * @param {object} [options.proxy] proxy override (defaults to the environment)
 * @param {string} [options.label] name used in failure messages (engine id)
 * @returns {Promise<{ status: number, text: string, url: string, truncated: boolean, cookies: string[], location?: string }>}
 */
export async function getText(url, options = {}) {
  const {
    signal,
    timeoutMs = 15000,
    acceptLanguage = 'en-US,en;q=0.9',
    headers = {},
    referer,
    redirect = 'follow',
    maxRedirects = MAX_REDIRECTS,
    maxBytes = FETCH_MAX_BYTES,
    publicOnly = false,
    proxy,
    label = 'request',
  } = options
  throwIfAborted(signal)
  const budget = deadline(signal, timeoutMs)
  try {
    let current = url instanceof URL ? url : new URL(url)
    for (let hop = 0; ; hop += 1) {
      const response = await request(current, {
        method: 'GET',
        signal: budget.signal,
        publicOnly,
        ...(proxy === undefined ? {} : { proxy }),
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': acceptLanguage,
          'cache-control': 'no-cache',
          ...(referer === undefined ? {} : { referer }),
          ...headers,
        },
      })
      const location = response.headers.get('location')
      if (redirect === 'manual') {
        response.stream?.destroy()
        return {
          status: response.status,
          text: '',
          url: current.toString(),
          truncated: false,
          cookies: response.headers.getSetCookie(),
          ...(location === null ? {} : { location: new URL(location, current).toString() }),
        }
      }
      if (isRedirect(response.status) && location !== null) {
        response.stream?.destroy()
        if (hop >= maxRedirects) throw providerError(`${label} exceeded the maximum of ${maxRedirects} redirects`)
        let next
        try {
          next = new URL(location, current)
        } catch (error) {
          throw providerError(`${label} redirect Location "${location}" is not a URL`, error)
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw providerError(`${label} redirected to unsupported scheme "${next.protocol}"`)
        }
        current = next
        continue
      }
      const { text, truncated } = await readCappedText(response, maxBytes)
      return {
        status: response.status,
        text,
        url: current.toString(),
        truncated,
        cookies: response.headers.getSetCookie(),
      }
    }
  } catch (error) {
    if (budget.timedOut()) throw providerError(`${label} timed out after ${timeoutMs}ms`, error)
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(`${label} aborted`, error)
    if (error instanceof FreeWebError) throw error
    throw providerError(`${label} request failed: ${describeTransportFailure(error)}`, error)
  } finally {
    budget.done()
  }
}

/**
 * Retrying GET for search engines.
 *
 * Keyless engines answer a burst with 429/5xx and recover on the next attempt, so
 * one retry with jitter is worth it; a timeout is never retried (it already spent
 * the whole engine budget). `retry-after` above the cap fails immediately instead
 * of holding the tool call open.
 *
 * @param {string} url absolute URL
 * @param {Parameters<typeof getText>[1] & { attempts?: number }} options getText options plus attempt count
 * @returns {ReturnType<typeof getText>>} response
 */
export async function getTextRetrying(url, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 2)
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await getText(url, options)
      const retriable = response.status === 429 || (response.status >= 500 && response.status < 600)
      if (!retriable || attempt === attempts - 1) return response
      const retryAfter = Number.parseFloat(options.retryAfterHeader ?? '')
      if (Number.isFinite(retryAfter) && retryAfter > 3) return response
      await sleep(400 + Math.random() * 400)
    } catch (error) {
      lastError = error
      if (error?.code === 'WEB_ABORTED' || attempt === attempts - 1) throw error
      await sleep(400 + Math.random() * 400)
    }
  }
  throw lastError ?? providerError(`${options.label ?? 'request'} failed with no response`)
}

/** Sleep for a bounded delay. */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Render a fetch failure with its cause chain, which is where Node puts the
 * actual network reason (`ECONNREFUSED`, `ENOTFOUND`, a proxy refusal).
 *
 * @param {unknown} error thrown value
 * @returns {string} one-line description
 */
export function describeFetchFailure(error) {
  return describeTransportFailure(error)
}

/**
 * Race a promise against cancellation, so a resolver or engine that ignores the
 * signal still settles its caller.
 *
 * @template T
 * @param {Promise<T>} promise work to await
 * @param {AbortSignal | undefined} signal caller cancellation
 * @param {string} label error label
 * @returns {Promise<T>} the work's result
 */
export async function abortable(promise, signal, label) {
  throwIfAborted(signal)
  if (signal === undefined) return await promise
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError(`${label} aborted`, signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export { FreeWebError, request, readCappedText }
