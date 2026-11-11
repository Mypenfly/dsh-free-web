/**
 * HTTP access for the free providers, on the host's global `fetch`.
 *
 * The host installs an undici dispatcher from its proxy policy before plugins
 * mount (`dsh-http-proxy`), so `fetch` here inherits the same proxy, bypass list,
 * and TLS settings as the shipped providers — a plugin-local HTTP stack would
 * silently diverge from the user's proxy configuration.
 *
 * Everything a provider needs beyond `fetch`'s defaults lives here: a browser-ish
 * header set (keyless engines reject obvious clients), a byte cap, per-request
 * timeouts, cancellation, and manual redirect following so the fetch provider can
 * validate every hop.
 */

import { FreeWebError, abortedError, providerError } from './errors.mjs'

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

/** True for a `fetch` abort caused by the caller's signal or our timeout. */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
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
 * Read a response body with a byte cap.
 *
 * @param {Response} response fetch response
 * @param {number} maxBytes cap
 * @returns {Promise<{ text: string, truncated: boolean, bytes: number }>} decoded body
 */
export async function readCappedText(response, maxBytes) {
  if (response.body === null) return { text: '', truncated: false, bytes: 0 }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    bytes += value.byteLength
    if (bytes > maxBytes) {
      const room = Math.max(0, maxBytes - (bytes - value.byteLength))
      if (room > 0) chunks.push(value.subarray(0, room))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return { text: decodeWithCharset(buffer, response.headers.get('content-type')), truncated, bytes }
}

/**
 * Decode bytes using the charset in `content-type`, defaulting to UTF-8.
 *
 * @param {Buffer} buffer raw bytes
 * @param {string | null} contentType response content type
 * @returns {string} decoded text
 */
export function decodeWithCharset(buffer, contentType) {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')
  const charset = match?.[1]?.toLowerCase()
  if (charset === undefined || charset === 'utf-8' || charset === 'utf8') {
    return buffer.toString('utf8')
  }
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/**
 * GET one URL as text with engine-friendly headers.
 *
 * @param {string} url absolute URL
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {number} [options.timeoutMs] request budget
 * @param {string} [options.acceptLanguage] Accept-Language header
 * @param {Record<string, string>} [options.headers] extra headers
 * @param {string} [options.referer] Referer header
 * @param {'follow' | 'manual'} [options.redirect] redirect policy
 * @param {number} [options.maxBytes] response cap
 * @param {string} [options.label] name used in failure messages (engine id)
 * @returns {Promise<{ status: number, text: string, url: string, truncated: boolean, location?: string }>}
 */
export async function getText(url, options = {}) {
  const {
    signal,
    timeoutMs = 15000,
    acceptLanguage = 'en-US,en;q=0.9',
    headers = {},
    referer,
    redirect = 'follow',
    maxBytes = FETCH_MAX_BYTES,
    label = 'request',
  } = options
  throwIfAborted(signal)
  const budget = deadline(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect,
      signal: budget.signal,
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': acceptLanguage,
        'cache-control': 'no-cache',
        ...(referer === undefined ? {} : { referer }),
        ...headers,
      },
    })
    if (redirect === 'manual') {
      budget.done()
      return {
        status: response.status,
        text: '',
        url: response.url === '' ? url : response.url,
        truncated: false,
        ...(response.headers.get('location') === null
          ? {}
          : { location: new URL(response.headers.get('location'), url).toString() }),
      }
    }
    const { text, truncated } = await readCappedText(response, maxBytes)
    budget.done()
    return {
      status: response.status,
      text,
      url: response.url === '' ? url : response.url,
      truncated,
      cookies: response.headers.getSetCookie(),
    }
  } catch (error) {
    if (budget.timedOut()) {
      throw providerError(`${label} timed out after ${timeoutMs}ms`, error)
    }
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(`${label} aborted`, error)
    throw providerError(`${label} request failed: ${describeFetchFailure(error)}`, error)
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
 * Render a fetch failure with its cause chain, which is where undici puts the
 * actual network reason (`ECONNREFUSED`, `ENOTFOUND`, proxy refusal).
 *
 * @param {unknown} error thrown value
 * @returns {string} one-line description
 */
export function describeFetchFailure(error) {
  const parts = []
  let current = error
  const seen = new Set()
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    parts.push(current.message)
    const code = /** @type {{ code?: unknown }} */ (current).code
    if (typeof code === 'string' && !parts.at(-1).includes(code)) parts[parts.length - 1] += ` (${code})`
    current = current.cause
  }
  return parts.filter((part) => part.length > 0).join(': ') || String(error)
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

export { FreeWebError }
