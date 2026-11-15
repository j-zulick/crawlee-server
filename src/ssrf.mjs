// Outbound URL guard. Every start URL, every enqueued URL and every final (post-redirect)
// URL goes through checkUrl(). The container's egress firewall is the second layer.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4int = ip => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const inV4 = (ip, [base, bits]) => bits === 0 || (v4int(ip) >>> (32 - bits)) === (v4int(base) >>> (32 - bits));

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return V4_BLOCKS.some(b => inV4(ip, b));
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return true;
}

export class UrlRefused extends Error { constructor(reason) { super(reason); this.name = 'UrlRefused'; this.reason = reason; } }

// policy: { allowPrivateHosts: Set<string> } — hostnames (e.g. a test fixture) exempt from the IP check.
export async function checkUrl(raw, policy = {}, resolver = lookup) {
  let u;
  try { u = new URL(raw); } catch { throw new UrlRefused('invalid_url'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UrlRefused('scheme_not_allowed');
  if (u.username || u.password) throw new UrlRefused('credentials_in_url');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allow = policy.allowPrivateHosts || new Set();
  if (allow.has(host)) return u;
  if (u.port && !['80', '443'].includes(u.port)) throw new UrlRefused('port_not_allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new UrlRefused('private_host');
  const addrs = net.isIP(host) ? [{ address: host }] : await resolver(host, { all: true, verbatim: true }).catch(() => { throw new UrlRefused('dns_failed'); });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new UrlRefused('private_address');
  return u;
}
