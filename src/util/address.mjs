/**
 * Destination-address policy, shared by the transport and the fetch provider.
 *
 * The provider validates an IP literal up front and the transport validates every
 * address it is about to connect to (or, behind a proxy, every address the name
 * resolves to). Keeping one implementation means a hop cannot pass one check and
 * fail the other.
 */

import { isIP } from 'node:net'

/**
 * True when an IP literal is a destination a web fetch must refuse.
 *
 * @param {string} address IPv4 or IPv6 literal
 * @returns {boolean} true for loopback, private, link-local, CGNAT, multicast, ...
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
 * True for hostnames that always mean the local machine, whatever DNS says.
 *
 * @param {string} host hostname without port or brackets
 * @returns {boolean} true for `localhost` and its subdomains
 */
export function isLoopbackName(host) {
  const lower = host.toLowerCase()
  return lower === 'localhost' || lower.endsWith('.localhost')
}
