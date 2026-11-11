/**
 * The plugin's own HTTP transport.
 *
 * Why not the host's global `fetch`: the modules a plugin loaded from an absolute
 * path can reach are the host's, but the *dispatcher* behind its `fetch` is an
 * undici detail of the host's HTTP layer, not a seam we can import. Leaning on it
 * also makes the plugin's SSRF story depend on undici's DNS handling, where a
 * custom `lookup` (the pin that closes the rebinding race) is unavailable.
 *
 * What this module owns instead:
 *  - direct connections with a pre-flight resolution check and the verified
 *    address pinned into the socket, so the name cannot resolve differently
 *    between check and connect;
 *  - proxy support from the environment: `CONNECT` tunnels for `https:` targets,
 *    absolute-form request lines for `http:` targets, `https://` proxies too;
 *  - one hop per call. Redirects stay with the caller, which is what lets the
 *    fetch provider validate every hop's origin and destination.
 *
 * Body decoding (gzip/deflate/br) happens in `readCappedText` rather than in the
 * stream, so a raw-deflate response can be retried after a failed inflate and the
 * decoded size is capped (a small compressed body must not expand into a bomb).
 * Node core only: no client library, no undici.
 */

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { isIP, isIPv6 } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

import { isLoopbackName, isNonPublicAddress } from './address.mjs'
import { FreeWebError, abortedError, providerError } from './errors.mjs'
import { proxyFor } from './proxy.mjs'

/** Ports implied by the URL scheme. */
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 }

/** Advertised encodings; `readCappedText` can undo all three. */
const DEFAULT_ACCEPT_ENCODING = 'gzip, deflate, br'

/** Hop-by-hop headers that must not be forwarded through a proxy request. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'])

/**
 * A `Headers`-shaped view over Node's raw header array.
 *
 * The callers were written against `fetch`, so they use `get` / `getSetCookie`.
 * Repeated headers are joined with `, ` the way HTTP says to, except `set-cookie`,
 * which stays a list.
 */
export class ResponseHeaders {
  /** @type {Map<string, string>} */
  #values = new Map()

  /** @type {string[]} */
  #cookies = []

  /**
   * @param {string[]} rawHeaders Node's `rawHeaders` (`[name, value, ...]`)
   */
  constructor(rawHeaders) {
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = rawHeaders[index].toLowerCase()
      const value = rawHeaders[index + 1]
      if (name === 'set-cookie') {
        this.#cookies.push(value)
        continue
      }
      const previous = this.#values.get(name)
      this.#values.set(name, previous === undefined ? value : `${previous}, ${value}`)
    }
  }

  /**
   * @param {string} name header name, case-insensitive
   * @returns {string | null} header value, or `null` when absent
   */
  get(name) {
    return this.#values.get(String(name).toLowerCase()) ?? null
  }

  /**
   * @param {string} name header name
   * @returns {boolean} true when the header is present
   */
  has(name) {
    return this.#values.has(String(name).toLowerCase())
  }

  /** @returns {string[]} every `set-cookie` value, in arrival order */
  getSetCookie() {
    return [...this.#cookies]
  }

  /** @returns {IterableIterator<[string, string]>} lowercased entries */
  entries() {
    return this.#values.entries()
  }
}

/**
 * Describe a network failure the way `undici` does: message plus the `code` that
 * says what actually went wrong (`ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`).
 *
 * @param {unknown} error thrown value
 * @returns {string} one-line description
 */
export function describeTransportFailure(error) {
  const parts = []
  const seen = new Set()
  let current = /** @type {any} */ (error)
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code = current.code
    parts.push(typeof code === 'string' && !current.message.includes(code) ? `${current.message} (${code})` : current.message)
    current = current.cause
  }
  return parts.filter((part) => part.length > 0).join(': ') || String(error)
}

/**
 * A `lookup` that can only ever return addresses that were already validated.
 *
 * Node calls it either in single-address mode (`(err, address, family)`) or in
 * `all` mode (happy eyeballs, Node's default for `net.connect`), so both shapes
 * are answered from the same verified set — the name is never resolved again.
 *
 * @param {Array<{ address: string, family: number }>} addresses verified answers
 * @returns {(hostname: string, options: any, callback: (...args: any[]) => void) => void} lookup
 */
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    const mode = typeof options === 'function' ? {} : (options ?? {})
    if (mode.all === true) done(null, addresses.map(({ address, family }) => ({ address, family })))
    else done(null, addresses[0].address, addresses[0].family)
  }
}

/**
 * Resolve one hostname and, when the caller demands public destinations, refuse
 * unless every answer is public.
 *
 * A mixed answer set is refused rather than filtered: the request must not be able
 * to land on the internal address just because DNS mentioned it.
 *
 * @param {string} host hostname (no brackets)
 * @param {boolean} publicOnly enforce the public-destination policy
 * @param {AbortSignal | undefined} signal cancellation
 * @returns {Promise<Array<{ address: string, family: number }>>} verified answers
 */
async function resolveDestination(host, publicOnly, signal) {
  if (isIP(host) !== 0) {
    if (publicOnly && (isNonPublicAddress(host) || isLoopbackName(host))) {
      throw new FreeWebError(`"${host}" is not a public address`, 'WEB_BLOCKED_URL')
    }
    return [{ address: host, family: isIP(host) }]
  }
  if (publicOnly && isLoopbackName(host)) {
    throw new FreeWebError(`"${host}" resolves to the loopback interface`, 'WEB_BLOCKED_URL')
  }
  let addresses
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw providerError(`could not resolve "${host}": ${describeTransportFailure(error)}`, error)
  }
  if (signal?.aborted === true) throw abortedError('web request aborted', signal.reason)
  if (addresses.length === 0) throw new FreeWebError(`"${host}" resolved to no addresses`, 'WEB_BLOCKED_URL')
  if (publicOnly) {
    for (const entry of addresses) {
      if (isNonPublicAddress(entry.address)) {
        throw new FreeWebError(`"${host}" resolves to the non-public address ${entry.address}`, 'WEB_BLOCKED_URL')
      }
    }
  }
  return addresses
}

/**
 * Merge caller headers with the ones the transport insists on.
 *
 * @param {Record<string, string>} headers caller headers
 * @param {string} hostHeader value for `host`
 * @returns {Record<string, string>} headers ready for the request
 */
function prepareHeaders(headers, hostHeader) {
  const out = {}
  let hasHost = false
  let hasEncoding = false
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host') hasHost = true
    if (lower === 'accept-encoding') hasEncoding = true
    out[key] = value
  }
  if (!hasHost) out.host = hostHeader
  if (!hasEncoding) out['accept-encoding'] = DEFAULT_ACCEPT_ENCODING
  return out
}

/**
 * Build the seam-facing response object from Node's `IncomingMessage`.
 *
 * @param {http.IncomingMessage} incoming response
 * @param {URL} url URL that produced it
 * @returns {{ url: string, status: number, statusMessage: string, ok: boolean, headers: ResponseHeaders, stream: http.IncomingMessage }} response
 */
function toResponse(incoming, url) {
  const status = incoming.statusCode ?? 0
  return {
    url: url.toString(),
    status,
    statusMessage: incoming.statusMessage ?? '',
    ok: status >= 200 && status < 300,
    headers: new ResponseHeaders(incoming.rawHeaders),
    stream: incoming,
  }
}

/**
 * Dial one endpoint and send the request.
 *
 * @param {'http:' | 'https:'} protocol wire protocol
 * @param {Record<string, any>} options `http.request` options
 * @param {URL} url URL used for the response object
 * @param {Buffer | string | undefined} body request body
 * @param {number | undefined} timeoutMs idle-socket budget
 * @returns {Promise<ReturnType<typeof toResponse>>} response headers plus body stream
 */
function send(protocol, options, url, body, timeoutMs) {
  const transport = protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (incoming) => resolve(toResponse(incoming, url)))
    req.once('error', reject)
    if (timeoutMs !== undefined) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new FreeWebError(`request timed out after ${timeoutMs}ms`, 'WEB_FETCH_TIMEOUT'))
      })
    }
    if (body === undefined) req.end()
    else req.end(body)
  })
}

/**
 * Open a `CONNECT` tunnel through an HTTP proxy.
 *
 * @param {{ scheme: string, hostname: string, port: number, authorization?: string }} proxy proxy endpoint
 * @param {string} host destination hostname (no brackets)
 * @param {number} port destination port
 * @param {AbortSignal | undefined} signal cancellation
 * @param {number | undefined} timeoutMs connect budget
 * @returns {Promise<import('node:net').Socket>} tunnel socket
 */
function openTunnel(proxy, host, port, signal, timeoutMs) {
  const authority = isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
  const transport = proxy.scheme === 'https' ? https : http
  const headers = { host: authority }
  if (proxy.authorization !== undefined) headers['proxy-authorization'] = proxy.authorization
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(error)
    }
    const req = transport.request(
      {
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        headers,
        agent: false,
        signal,
      },
      () => {
        // A CONNECT response without the tunnel socket is a proxy bug; the
        // 'connect' event is the contract, so nothing arrives here in practice.
      },
    )
    req.once('connect', (response, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy()
        reject(
          new FreeWebError(
            `proxy ${proxy.scheme}://${proxy.hostname}:${proxy.port} refused CONNECT ${authority} with HTTP ${response.statusCode}`,
            'WEB_PROVIDER_ERROR',
          ),
        )
        return
      }
      if (head !== undefined && head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    req.once('error', fail)
    if (timeoutMs !== undefined) {
      req.setTimeout(timeoutMs, () => fail(new FreeWebError(`proxy connect timed out after ${timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')))
    }
    req.end()
  })
}

/**
 * Wrap a tunnelled socket in TLS for the destination host.
 *
 * @param {import('node:net').Socket} socket tunnel
 * @param {string} host destination hostname
 * @param {AbortSignal | undefined} signal cancellation
 * @returns {Promise<import('node:tls').TLSSocket>} secure socket
 */
function startTls(socket, host, signal) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, any>} */
    const options = { socket, ALPNProtocols: ['http/1.1'] }
    // SNI must be a name; an IP destination is validated against its IP SANs.
    if (isIP(host) === 0) options.servername = host
    const tlsSocket = tls.connect(options)
    const onAbort = () => {
      tlsSocket.destroy()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('request aborted'))
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    tlsSocket.once('secureConnect', () => {
      cleanup()
      resolve(tlsSocket)
    })
    tlsSocket.once('error', (error) => {
      cleanup()
      reject(error)
    })
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Agent that hands `https.request` the socket we already established, instead of
 * dialling (and wrapping in TLS) a second time.
 */
class TunnelAgent extends https.Agent {
  /** @type {import('node:tls').TLSSocket} */
  #socket

  /**
   * @param {import('node:tls').TLSSocket} socket established TLS socket
   */
  constructor(socket) {
    super({ keepAlive: false })
    this.#socket = socket
  }

  /** @returns {import('node:tls').TLSSocket} the established socket */
  createConnection() {
    return this.#socket
  }
}

/**
 * One HTTP request, one hop.
 *
 * @param {string | URL} input absolute URL
 * @param {object} [options]
 * @param {string} [options.method] HTTP method
 * @param {Record<string, string>} [options.headers] request headers
 * @param {AbortSignal} [options.signal] cancellation and overall budget
 * @param {boolean} [options.publicOnly] refuse non-public destinations
 * @param {{ scheme: 'http' | 'https', hostname: string, port: number, authorization?: string } | null} [options.proxy]
 *   proxy override; omit to read the environment, pass `null` to force a direct connection
 * @param {Buffer | string} [options.body] request body
 * @param {number} [options.timeoutMs] idle-socket budget (the signal still bounds the call)
 * @returns {Promise<{ url: string, status: number, statusMessage: string, ok: boolean, headers: ResponseHeaders, stream: http.IncomingMessage }>}
 *   status, headers, and the still-unread body stream
 */
export async function request(input, options = {}) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FreeWebError(`only http and https requests are supported, got "${url.protocol}"`, 'WEB_INVALID_URL')
  }
  const {
    method = 'GET',
    headers = {},
    signal,
    publicOnly = false,
    proxy: proxyOption,
    body,
    timeoutMs,
  } = options
  if (signal?.aborted === true) throw abortedError('web request aborted', signal.reason)
  // `proxy: null` means "direct, whatever the environment says"; omitting the
  // option means "use the environment".
  const proxy = proxyOption === undefined ? proxyFor(url) : (proxyOption ?? undefined)

  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port)
  const outbound = prepareHeaders(headers, url.host)
  const path = `${url.pathname}${url.search}`

  // Direct connections always resolve here, so the socket can be pinned to the
  // verified answers. Behind a proxy the name is resolved by the proxy, but a
  // public-only request still has to prove the destination is public.
  const addresses = proxy === undefined || publicOnly
    ? await resolveDestination(host, publicOnly, signal)
    : undefined

  if (proxy === undefined) {
    return await send(
      url.protocol,
      {
        host,
        port,
        path,
        method,
        headers: outbound,
        lookup: pinnedLookup(addresses ?? []),
        agent: false,
        signal,
      },
      url,
      body,
      timeoutMs,
    )
  }

  const proxyHeaders = { ...outbound }
  if (proxy.authorization !== undefined) proxyHeaders['proxy-authorization'] = proxy.authorization

  if (url.protocol === 'http:') {
    // Absolute-form request line; the proxy resolves the destination.
    return await send(
      proxy.scheme === 'https' ? 'https:' : 'http:',
      {
        host: proxy.hostname,
        port: proxy.port,
        path: `${url.protocol}//${url.host}${path}`,
        method,
        headers: proxyHeaders,
        agent: false,
        signal,
      },
      url,
      body,
      timeoutMs,
    )
  }

  const socket = await openTunnel(proxy, host, port, signal, timeoutMs)
  const secureSocket = await startTls(socket, host, signal)
  try {
    return await send(
      'https:',
      {
        host,
        port,
        path,
        method,
        headers: outbound,
        agent: new TunnelAgent(secureSocket),
        signal,
      },
      url,
      body,
      timeoutMs,
    )
  } catch (error) {
    secureSocket.destroy()
    throw error
  }
}

/**
 * Read a body stream into memory with a byte cap.
 *
 * @param {import('node:stream').Readable | null | undefined} stream body stream
 * @param {number} maxBytes cap on stored bytes
 * @returns {Promise<{ buffer: Buffer, truncated: boolean, bytes: number }>} raw bytes
 */
export async function readRaw(stream, maxBytes) {
  if (stream === null || stream === undefined) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 }
  const chunks = []
  let bytes = 0
  let truncated = false
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(/** @type {Uint8Array} */ (chunk))
    bytes += buffer.length
    const room = maxBytes - (bytes - buffer.length)
    if (buffer.length > room) {
      if (room > 0) chunks.push(buffer.subarray(0, room))
      truncated = true
      stream.destroy()
      break
    }
    chunks.push(buffer)
  }
  return { buffer: Buffer.concat(chunks), truncated, bytes }
}

/**
 * Run one decompressor over a complete input, keeping at most `cap` output bytes.
 *
 * @param {Buffer} input encoded bytes
 * @param {() => import('node:stream').Transform} create decoder factory
 * @param {number} cap output cap
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>} decoded bytes
 */
function decodeStream(input, create, cap) {
  return new Promise((resolve, reject) => {
    const decoder = create()
    const chunks = []
    let size = 0
    let truncated = false
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      decoder.removeAllListeners()
      decoder.destroy()
      if (error !== undefined) reject(error)
      else resolve({ buffer: Buffer.concat(chunks), truncated })
    }
    decoder.on('data', (chunk) => {
      if (settled) return
      const room = cap - size
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room))
          size = cap
        }
        truncated = true
        finish()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    decoder.once('end', () => finish())
    decoder.once('error', (error) => finish(error))
    decoder.end(input)
  })
}

/**
 * True for the particular zlib failure that means "this was raw deflate".
 *
 * @param {unknown} error thrown by a decoder
 * @returns {boolean} true when a raw-deflate retry makes sense
 */
function isZlibDataError(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code
  return code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR'
}

/**
 * Undo one content encoding.
 *
 * @param {Buffer} input encoded bytes
 * @param {string} encoding lowercased token
 * @param {number} cap output cap
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>} decoded bytes
 */
async function decodeOne(input, encoding, cap) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return await decodeStream(input, () => zlib.createGunzip(), cap)
  if (encoding === 'br') return await decodeStream(input, () => zlib.createBrotliDecompress(), cap)
  if (encoding === 'deflate') {
    try {
      return await decodeStream(input, () => zlib.createInflate(), cap)
    } catch (error) {
      // Plenty of servers send raw deflate without the zlib wrapper; undici
      // retries too, and so do we, because the input buffer is still intact.
      if (isZlibDataError(error)) return await decodeStream(input, () => zlib.createInflateRaw(), cap)
      throw error
    }
  }
  throw providerError(`unsupported content-encoding "${encoding}"`)
}

/**
 * Undo the whole `content-encoding` chain, right to left, capped at `maxBytes`.
 *
 * @param {Buffer} buffer raw body
 * @param {string | null} encodingHeader `content-encoding` value
 * @param {number} maxBytes cap on decoded bytes
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>} decoded body
 */
export async function decodeContent(buffer, encodingHeader, maxBytes) {
  const encodings = (encodingHeader ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '' && token !== 'identity')
  if (encodings.length === 0 || buffer.length === 0) return { buffer, truncated: false }
  let current = buffer
  for (const encoding of encodings.reverse()) {
    const result = await decodeOne(current, encoding, maxBytes)
    current = result.buffer
    if (result.truncated) return { buffer: current, truncated: true }
  }
  return { buffer: current, truncated: false }
}

/**
 * Read a response body as text: byte cap, then content-encoding, then charset.
 *
 * @param {{ headers: ResponseHeaders, stream: import('node:stream').Readable | null }} response transport response
 * @param {number} maxBytes cap on bytes and on decoded bytes
 * @returns {Promise<{ text: string, truncated: boolean, bytes: number }>} decoded body
 */
export async function readCappedText(response, maxBytes) {
  const raw = await readRaw(response.stream, maxBytes)
  const decoded = await decodeContent(raw.buffer, response.headers.get('content-encoding'), maxBytes)
  return {
    text: decodeWithCharset(decoded.buffer, response.headers.get('content-type')),
    truncated: raw.truncated || decoded.truncated,
    bytes: raw.bytes,
  }
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
  if (charset === undefined || charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8')
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}
