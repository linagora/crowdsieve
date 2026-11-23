/**
 * Classification of IP addresses for external reputation lookups.
 *
 * Pure string parsing (no Node `net` module) so it can run in the browser.
 */

/** Parse a strict dotted-quad IPv4 address into 4 octets. */
function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Parse an IPv6 address into 8 16-bit groups (no zone id, no prefix length). */
function parseIPv6(value: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(value) || !value.includes(':')) return null;

  let text = value;
  // Embedded IPv4 in the last 32 bits (e.g. ::ffff:192.0.2.1)
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const rest = parseGroups(halves[1]);
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** True for IPv4 addresses that are not routable on the public Internet. */
function isNonPublicIPv4([a, b]: number[]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 (unspecified, "this network")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/**
 * Whether `value` is a single IP address a public reputation service can
 * know about. Returns false for CIDR ranges, anything that is not an IP, and
 * for unspecified, loopback, private, link-local, ULA, CGNAT, multicast and
 * reserved addresses (including IPv4-mapped or NAT64 forms of those).
 * Documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24,
 * 2001:db8::/32) are deliberately treated as public.
 */
export function isPublicIp(value: string | null | undefined): boolean {
  if (!value) return false;
  const ip = value.trim();

  const v4 = parseIPv4(ip);
  if (v4) return !isNonPublicIPv4(v4);

  const g = parseIPv6(ip);
  if (!g) return false;

  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1

  const embedded = (): number[] => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96)
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    return !isNonPublicIPv4(embedded());
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return !isNonPublicIPv4(embedded());
  }

  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

/** CrowdSec CTI page for an IP address. */
export function ctiUrl(ip: string): string {
  return `https://app.crowdsec.net/cti/${encodeURIComponent(ip.trim())}`;
}
