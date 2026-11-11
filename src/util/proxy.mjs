/**
 * Proxy selection from the environment.
 *
 * The host's own `fetch` honours `http_proxy` / `https_proxy` / `all_proxy` /
 * `no_proxy` through an undici dispatcher. The plugin cannot reach that dispatcher
 * (it lives in the host's module graph), and on a proxied machine a bare
 * `node:http` request simply times out, so the same rules are reimplemented here:
 *
 *  - scheme-specific variable first, `all_proxy` as the fallback;
 *  - lowercase wins over uppercase, the way curl and undici resolve them;
 *  - `no_proxy` accepts `*`, exact hosts, domain suffixes, `host:port`, bracketed
 *    IPv6 literals, and IPv4 CIDR blocks (this machine's `no_proxy` is CIDR-heavy);
 *  - `socks*://` proxies are not implemented, so they fall back to a direct
 *    connection instead of silently pretending to be proxied.
 */

/** Default port per proxy scheme. */
const PROXY_PORTS = { 'http:': 80, 'https:': 443 }

/**
 * Read the proxy variables, lowercase first then uppercase.
 *
 * @param {Record<string, string | undefined>} [env] environment to read
 * @returns {{ http?: string, https?: string, all?: string, noProxy?: string }} raw values
 */
export function readProxyEnv(env = process.env) {
  const pick = (name) => {
    for (const key of [name, name.toUpperCase()]) {
      const value = env[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }
  return {
    http: pick('http_proxy'),
    https: pick('https_proxy'),
    all: pick('all_proxy'),
    noProxy: pick('no_proxy'),
  }
}

/**
 * Parse one proxy URL into the shape the transport dials.
 *
 * @param {string | undefined} raw proxy variable value
 * @returns {{ scheme: 'http' | 'https', hostname: string, port: number, authorization?: string } | undefined}
 *   proxy endpoint, or `undefined` when the value is missing or unsupported
 */
export function parseProxyUrl(raw) {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value === '') return undefined
  // `all_proxy=127.0.0.1:7897` is common; only a scheme-less value needs helping.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const port = url.port === '' ? PROXY_PORTS[url.protocol] : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const credentials = url.username === '' && url.password === ''
    ? undefined
    : Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    ...(credentials === undefined ? {} : { authorization: `Basic ${credentials}` }),
  }
}

/**
 * `scheme://host:port`, for diagnostics.
 *
 * @param {{ scheme: string, hostname: string, port: number }} proxy endpoint
 * @returns {string} printable endpoint
 */
export function describeProxy(proxy) {
  return `${proxy.scheme}://${proxy.hostname}:${proxy.port}`
}

/**
 * Split a `no_proxy` value into entries.
 *
 * @param {string | undefined} value raw variable
 * @returns {string[]} trimmed entries
 */
export function parseNoProxy(value) {
  if (typeof value !== 'string') return []
  return value.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/**
 * Parse one `no_proxy` entry.
 *
 * @param {string} entry raw entry
 * @returns {{ host?: string, port?: number, cidr?: { address: string, bits: number } } | undefined}
 *   matcher, or `undefined` for an entry with no usable host
 */
export function parseNoProxyEntry(entry) {
  let value = entry.trim().toLowerCase()
  if (value === '') return undefined
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(value)
  if (scheme !== null) value = value.slice(scheme[0].length)
  // CIDR first: its `/bits` suffix must not be mistaken for a path.
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(value)
  if (cidr !== null) {
    const bits = Number(cidr[2])
    if (bits > 32) return undefined
    return { cidr: { address: cidr[1], bits } }
  }
  value = value.replace(/\/.*$/, '')
  if (value === '') return undefined
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 0) return undefined
    const host = value.slice(1, close)
    const tail = value.slice(close + 1)
    const port = tail.startsWith(':') ? Number.parseInt(tail.slice(1), 10) : undefined
    return { host, ...(Number.isInteger(port) ? { port } : {}) }
  }
  const withPort = /^([^:]+):(\d+)$/.exec(value)
  if (withPort !== null) return { host: withPort[1], port: Number(withPort[2]) }
  return { host: value.replace(/^\./, '') }
}

/**
 * Convert a dotted IPv4 literal to an integer, for CIDR comparison.
 *
 * @param {string} address IPv4 literal
 * @returns {number | undefined} numeric value
 */
function ipv4ToInt(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  return octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3]
}

/**
 * Membership test for an IPv4 CIDR block.
 *
 * @param {string} address IPv4 literal
 * @param {{ address: string, bits: number }} cidr block
 * @returns {boolean} true when the address is inside the block
 */
export function ipv4InCidr(address, cidr) {
  const target = ipv4ToInt(address)
  const network = ipv4ToInt(cidr.address)
  if (target === undefined || network === undefined) return false
  if (cidr.bits === 0) return true
  const size = 2 ** (32 - cidr.bits)
  return Math.floor(target / size) === Math.floor(network / size)
}

/**
 * True when a destination bypasses the proxy.
 *
 * @param {string} host destination hostname (no brackets)
 * @param {number} port destination port
 * @param {string | undefined} noProxy `no_proxy` value
 * @returns {boolean} true when the request should go direct
 */
export function matchesNoProxy(host, port, noProxy) {
  const entries = parseNoProxy(noProxy)
  if (entries.length === 0) return false
  const lower = host.toLowerCase()
  const isLiteral = /^[0-9.]+$/.test(lower) || lower.includes(':')
  for (const entry of entries) {
    if (entry === '*') return true
    const matcher = parseNoProxyEntry(entry)
    if (matcher === undefined) continue
    if (matcher.port !== undefined && matcher.port !== port) continue
    if (matcher.cidr !== undefined) {
      if (/^[0-9.]+$/.test(lower) && ipv4InCidr(lower, matcher.cidr)) return true
      continue
    }
    const target = matcher.host
    if (target === undefined) continue
    if (isLiteral) {
      if (lower === target) return true
      continue
    }
    if (lower === target || lower.endsWith(`.${target}`)) return true
  }
  return false
}

/**
 * Pick the proxy for one destination URL.
 *
 * @param {string | URL} url destination
 * @param {Record<string, string | undefined>} [env] environment to read
 * @returns {{ scheme: 'http' | 'https', hostname: string, port: number, authorization?: string } | undefined}
 *   proxy endpoint, or `undefined` for a direct connection
 */
export function proxyFor(url, env = process.env) {
  const target = url instanceof URL ? url : new URL(String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const port = target.port === '' ? PROXY_PORTS[target.protocol] : Number(target.port)
  const values = readProxyEnv(env)
  if (matchesNoProxy(host, port, values.noProxy)) return undefined
  const raw = target.protocol === 'https:' ? (values.https ?? values.all) : (values.http ?? values.all)
  return parseProxyUrl(raw)
}
