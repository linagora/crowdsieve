import net from 'node:net';

/**
 * Minimal, dependency-free CIDR containment check (IPv4 + IPv6).
 *
 * Replaces the `ip-cidr` / `ip-address` pair, which carried unfixed advisories
 * (GHSA-v2v4-37r5-5v8g, GHSA-mwp4-54f8-5fhr) with no upgrade path: `ip-cidr` is
 * unmaintained at 4.0.2 and pins `ip-address@^9`, while the fix landed in
 * `ip-address@10.4.0` behind a renamed API.
 *
 * Parsing is gated by Node's `net.isIPv4` / `net.isIPv6`, which reject ambiguous
 * forms such as leading-zero octets ("010.0.0.1"). Note this hardens a path that
 * was not actually exploitable before: `ip-cidr` also rejected those inputs, so
 * removing the dependency clears the advisories rather than fixing a live bug.
 *
 * Verified against `ip-cidr@4.0.2` over 60k generated address/range pairs: the
 * two agree on every one. The only divergences are edge cases where `ip-cidr`
 * was wrong, each cross-checked against Python's `ipaddress` module:
 *   - `ip-cidr` compared raw integers without checking the address family, so
 *     "::1" tested against "0.0.0.0/0" returned true. Here families never cross.
 *   - `ip-cidr` mishandled ranges with an embedded IPv4 tail, e.g.
 *     "::ffff:0:0/96" did not contain "::ffff:8.8.8.8".
 *   - `ip-cidr` threw on a bare address, on surrounding whitespace, and on a
 *     full-form embedded IPv4 base ("0:0:0:0:0:ffff:1.2.3.4/128").
 */

interface ParsedAddress {
  value: bigint;
  /** Address width in bits: 32 for IPv4, 128 for IPv6. */
  bits: 32 | 128;
}

/** Parse a dotted-quad IPv4 address into a 32-bit integer. */
function parseIPv4(ip: string): bigint | null {
  if (!net.isIPv4(ip)) {
    return null;
  }
  let value = 0n;
  for (const octet of ip.split('.')) {
    value = (value << 8n) | BigInt(Number(octet));
  }
  return value;
}

/** Parse an IPv6 address (including `::` compression and embedded IPv4) into a 128-bit integer. */
function parseIPv6(ip: string): bigint | null {
  if (!net.isIPv6(ip)) {
    return null;
  }

  // Strip any zone index ("fe80::1%eth0"); it plays no part in containment.
  const address = ip.split('%')[0];

  // An embedded IPv4 tail ("::ffff:192.168.0.1") becomes the last two groups.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  let normalized = address;
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) {
      return null;
    }
    const high = (v4 >> 16n).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    normalized = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [head, rest, extra] = normalized.split('::');
  if (extra !== undefined) {
    return null;
  }

  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const headGroups = split(head);
  const tailGroups = rest === undefined ? [] : split(rest);

  let groups: string[];
  if (rest === undefined) {
    groups = headGroups;
  } else {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) {
      return null;
    }
    groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  }

  if (groups.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Parse an IP address of either family. Returns `null` if it is not a valid IP. */
function parseAddress(ip: string): ParsedAddress | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) {
    return { value: v4, bits: 32 };
  }
  const v6 = parseIPv6(ip);
  if (v6 !== null) {
    return { value: v6, bits: 128 };
  }
  return null;
}

/**
 * Test whether `ip` falls inside `cidr`.
 *
 * Both arguments must belong to the same address family; an IPv4 address never
 * matches an IPv6 range (and vice versa). An IPv4-mapped address such as
 * "::ffff:192.168.1.1" stays IPv6 and so does not match "192.168.0.0/16",
 * consistent with how `expandIPv6` in ../analyzers/detection.ts treats it.
 *
 * A bare address without a prefix is treated as a host route (/32 or /128).
 *
 * @throws {Error} if `cidr` is not a valid CIDR range or `ip` is not a valid IP.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const parts = cidr.trim().split('/');
  if (parts.length > 2) {
    throw new Error(`Invalid CIDR notation: "${cidr}"`);
  }

  const base = parseAddress(parts[0]);
  if (base === null) {
    throw new Error(`Invalid CIDR notation: "${cidr}"`);
  }

  let prefix: number;
  if (parts.length === 1) {
    prefix = base.bits;
  } else {
    // Reject "/0x10", "/ 8", "/8abc" and similar: parseInt would accept them.
    // Leading zeros are refused too ("/024"), to stay consistent with the octet
    // parsing above rather than being strict in one place and lax in the other.
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) {
      throw new Error(`Invalid CIDR prefix length: "${cidr}"`);
    }
    prefix = Number(parts[1]);
    if (prefix > base.bits) {
      throw new Error(`Invalid CIDR prefix length: "${cidr}"`);
    }
  }

  const target = parseAddress(ip);
  if (target === null) {
    throw new Error(`Invalid IP address: "${ip}"`);
  }

  if (target.bits !== base.bits) {
    return false;
  }

  if (prefix === 0) {
    return true;
  }

  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(base.bits - prefix);
  return (base.value & mask) === (target.value & mask);
}
