import net from 'node:net'

/** Effective client identity for rate limiting.
 *
 * Only a peer inside TRUSTED_PROXY_CIDRS (Caddy) may name the client, through
 * one header that the proxy overwrites. Every forwarding header from any other
 * peer is ignored, so a client cannot choose its own bucket. IPv4-mapped IPv6
 * addresses are treated as IPv4. IPv6 clients are keyed by their /64, the
 * smallest prefix normally assigned to one subscriber. The address is used
 * only in memory and is never logged or stored. */

function ipv4Bytes(text) {
  return Uint8Array.from(text.split('.').map(Number))
}

function ipv6Bytes(text) {
  let body = text
  let embedded = null
  const lastColon = body.lastIndexOf(':')
  if (body.slice(lastColon + 1).includes('.')) {
    embedded = ipv4Bytes(body.slice(lastColon + 1))
    body = `${body.slice(0, lastColon + 1)}0:0`
  }
  const halves = body.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length > 1 ? new Array(8 - left.length - right.length).fill('0') : []
  const groups = [...left, ...fill, ...right]
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  })
  if (embedded) bytes.set(embedded, 12)
  return bytes
}

function isMappedIpv4(bytes) {
  return bytes.length === 16 && bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
}

/** `{ family: 4|6, bytes }` for one IP literal (no zone, no brackets, no
 * port), with IPv4-mapped IPv6 normalised to IPv4; null when invalid. */
export function parseIp(text) {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (value.length === 0 || value.length > 45 || value.includes('%')) return null
  if (net.isIPv4(value)) return { family: 4, bytes: ipv4Bytes(value) }
  if (!net.isIPv6(value)) return null
  const bytes = ipv6Bytes(value)
  return isMappedIpv4(bytes) ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes }
}

/** `{ family, bytes, prefix }` for `address/prefix` or a single address. */
export function parseCidr(text) {
  if (typeof text !== 'string') return null
  const [addressText, prefixText, extra] = text.trim().split('/')
  if (extra !== undefined) return null
  const trimmed = addressText.trim()
  if (trimmed.includes('%') || !net.isIP(trimmed)) return null
  const raw = net.isIPv4(trimmed) ? { family: 4, bytes: ipv4Bytes(trimmed) } : { family: 6, bytes: ipv6Bytes(trimmed) }
  const width = raw.family === 4 ? 32 : 128
  let prefix = width
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/u.test(prefixText.trim())) return null
    prefix = Number(prefixText.trim())
    if (prefix > width) return null
  }
  if (raw.family === 6 && isMappedIpv4(raw.bytes) && prefix >= 96) {
    return { family: 4, bytes: raw.bytes.slice(12), prefix: prefix - 96 }
  }
  return { ...raw, prefix }
}

export function cidrContains(cidr, ip) {
  if (!cidr || !ip || cidr.family !== ip.family) return false
  const fullBytes = Math.floor(cidr.prefix / 8)
  for (let index = 0; index < fullBytes; index++) {
    if (cidr.bytes[index] !== ip.bytes[index]) return false
  }
  const remainder = cidr.prefix % 8
  if (remainder === 0) return true
  const mask = (0xff << (8 - remainder)) & 0xff
  return (cidr.bytes[fullBytes] & mask) === (ip.bytes[fullBytes] & mask)
}

/** The rate-limit key: an IPv4 address, or an IPv6 /64 prefix. */
export function ipKey(ip) {
  if (ip.family === 4) return ip.bytes.join('.')
  const groups = []
  for (let index = 0; index < 8; index += 2) groups.push(((ip.bytes[index] << 8) | ip.bytes[index + 1]).toString(16))
  return `${groups.join(':')}::/64`
}

/** `{ key, source }` with source 'peer' (direct client or untrusted peer),
 * 'header' (named by a trusted proxy) or 'fallback' (a trusted proxy sent no
 * usable header; the proxy's own address is the key). */
export function clientIdentity(request, { trustedProxies = [], header = 'x-telemetry-client-ip' } = {}) {
  const peer = parseIp(request.socket?.remoteAddress)
  if (!peer) return { key: 'unknown', source: 'peer' }
  if (!trustedProxies.some(cidr => cidrContains(cidr, peer))) return { key: ipKey(peer), source: 'peer' }
  // Node joins repeated headers with ", ", which then fails to parse as one
  // address: a trusted proxy must send exactly one.
  const named = parseIp(request.headers[header])
  if (!named) return { key: ipKey(peer), source: 'fallback' }
  return { key: ipKey(named), source: 'header' }
}
