import assert from 'node:assert/strict'
import test from 'node:test'
import { cidrContains, clientIdentity, ipKey, parseCidr, parseIp } from '../src/http/client-identity.js'

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers }
}

const caddy = { trustedProxies: ['172.18.0.0/16', 'fd00:ca:dd1e::/48'].map(parseCidr), header: 'x-telemetry-client-ip' }

test('parses IPv4, IPv6 and IPv4-mapped IPv6 literals', () => {
  assert.deepEqual(parseIp('203.0.113.7'), { family: 4, bytes: Uint8Array.from([203, 0, 113, 7]) })
  assert.equal(parseIp('2001:db8::1').family, 6)
  assert.deepEqual(parseIp('::ffff:203.0.113.7'), { family: 4, bytes: Uint8Array.from([203, 0, 113, 7]) })
  assert.deepEqual(parseIp('::ffff:cb00:7107'), { family: 4, bytes: Uint8Array.from([203, 0, 113, 7]) })
  assert.equal(ipKey(parseIp('::1')), '0:0:0:0::/64')
  for (const bad of ['', '1.2.3', '1.2.3.256', 'fe80::1%eth0', '[::1]', '1.2.3.4:80', '1.2.3.4, 5.6.7.8', 'x', null, ['1.2.3.4']]) {
    assert.equal(parseIp(bad), null, String(bad))
  }
})

test('matches IPv4 and IPv6 CIDRs, including mapped IPv4 ranges', () => {
  assert.ok(cidrContains(parseCidr('10.0.0.0/8'), parseIp('10.255.1.2')))
  assert.ok(!cidrContains(parseCidr('10.0.0.0/8'), parseIp('11.0.0.1')))
  assert.ok(cidrContains(parseCidr('192.168.1.128/25'), parseIp('192.168.1.200')))
  assert.ok(!cidrContains(parseCidr('192.168.1.128/25'), parseIp('192.168.1.127')))
  assert.ok(cidrContains(parseCidr('0.0.0.0/0'), parseIp('8.8.8.8')))
  assert.ok(!cidrContains(parseCidr('0.0.0.0/0'), parseIp('2001:db8::1')))
  assert.ok(cidrContains(parseCidr('2001:db8::/32'), parseIp('2001:db8:ffff::1')))
  assert.ok(!cidrContains(parseCidr('2001:db8::/33'), parseIp('2001:db8:8000::1')))
  assert.ok(cidrContains(parseCidr('172.18.0.5'), parseIp('::ffff:172.18.0.5')))
  assert.ok(cidrContains(parseCidr('::ffff:172.18.0.0/112'), parseIp('172.18.3.4')))
  for (const bad of ['10.0.0.0/33', '::/129', '10.0.0.0/8/1', 'x/8', '10.0.0.0/-1', '10.0.0.0/ab']) {
    assert.equal(parseCidr(bad), null, bad)
  }
})

test('groups IPv6 clients by /64 and keeps IPv4 clients separate', () => {
  const first = clientIdentity(request('2001:db8:1:2:aaaa::1'))
  const sameSubnet = clientIdentity(request('2001:db8:1:2:ffff:ffff:ffff:ffff'))
  const otherSubnet = clientIdentity(request('2001:db8:1:3::1'))
  assert.equal(first.key, '2001:db8:1:2::/64')
  assert.equal(first.key, sameSubnet.key)
  assert.notEqual(first.key, otherSubnet.key)
  assert.notEqual(clientIdentity(request('203.0.113.7')).key, clientIdentity(request('203.0.113.8')).key)
  assert.equal(clientIdentity(request('::ffff:203.0.113.7')).key, '203.0.113.7')
})

test('ignores forwarding headers from untrusted peers (spoofing)', () => {
  const spoofed = request('198.51.100.9', {
    'x-telemetry-client-ip': '203.0.113.50',
    'x-forwarded-for': '203.0.113.51',
    'x-real-ip': '203.0.113.52',
    forwarded: 'for=203.0.113.53',
  })
  assert.deepEqual(clientIdentity(spoofed, caddy), { key: '198.51.100.9', source: 'peer' })
  assert.deepEqual(clientIdentity(spoofed), { key: '198.51.100.9', source: 'peer' })
})

test('believes only the configured header from a trusted proxy', () => {
  const viaCaddy = request('172.18.0.3', { 'x-telemetry-client-ip': '203.0.113.50', 'x-forwarded-for': '203.0.113.99' })
  assert.deepEqual(clientIdentity(viaCaddy, caddy), { key: '203.0.113.50', source: 'header' })
  // Separate clients behind the same proxy get separate keys.
  const other = request('172.18.0.3', { 'x-telemetry-client-ip': '203.0.113.51' })
  assert.notEqual(clientIdentity(other, caddy).key, clientIdentity(viaCaddy, caddy).key)
  // A trusted proxy reached over a mapped IPv6 socket, and an IPv6 proxy.
  assert.equal(clientIdentity(request('::ffff:172.18.0.3', { 'x-telemetry-client-ip': '2001:db8:5:6::7' }), caddy).key, '2001:db8:5:6::/64')
  assert.equal(clientIdentity(request('fd00:ca:dd1e::2', { 'x-telemetry-client-ip': '::ffff:203.0.113.5' }), caddy).key, '203.0.113.5')
})

test('falls back to the proxy address when a trusted proxy sends no single valid IP', () => {
  for (const value of [undefined, '', 'garbage', '203.0.113.50, 203.0.113.51', '203.0.113.50:443', 'fe80::1%eth0']) {
    const headers = value === undefined ? {} : { 'x-telemetry-client-ip': value }
    assert.deepEqual(clientIdentity(request('172.18.0.3', headers), caddy), { key: '172.18.0.3', source: 'fallback' }, String(value))
  }
  assert.deepEqual(clientIdentity(request(undefined), caddy), { key: 'unknown', source: 'peer' })
})
