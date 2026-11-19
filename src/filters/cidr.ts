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
 * Addresses are held as four unsigned 32-bit words (an IPv4 address uses the
 * first one only), and a range keeps its base already masked together with the
 * per-word masks, so a match is a few AND-and-compare steps on plain numbers.
 * Callers that test one address against many ranges should parse once with
 * `parseIp` / `parseCidr` and call `cidrMatches`; `cidrContains` is the
 * one-shot convenience wrapper around them.
 *
 * The previous BigInt implementation was verified against `ip-cidr@4.0.2` over
 * 60k generated address/range pairs: the two agree on every one. This
 * implementation was in turn verified against the BigInt one by differential
 * testing (millions of pairs). The only divergences from `ip-cidr` are edge
 * cases where it was wrong, each cross-checked against Python's `ipaddress`
 * module:
 *   - `ip-cidr` compared raw integers without checking the address family, so
 *     "::1" tested against "0.0.0.0/0" returned true. Here families never cross.
 *   - `ip-cidr` mishandled ranges with an embedded IPv4 tail, e.g.
 *     "::ffff:0:0/96" did not contain "::ffff:8.8.8.8".
 *   - `ip-cidr` threw on a bare address, on surrounding whitespace, and on a
 *     full-form embedded IPv4 base ("0:0:0:0:0:ffff:1.2.3.4/128").
 */

/**
 * A parsed IP address.
 *
 * The address is split into four unsigned 32-bit words, most significant
 * first. An IPv4 address is stored in `w0`; `w1` to `w3` are then 0.
 */
export interface ParsedIp {
  /** Address width in bits: 32 for IPv4, 128 for IPv6. */
  readonly bits: 32 | 128;
  readonly w0: number;
  readonly w1: number;
  readonly w2: number;
  readonly w3: number;
}

/**
 * A parsed CIDR range.
 *
 * `w0`-`w3` hold the base address with its host bits already cleared, and
 * `m0`-`m3` the matching per-word masks (unsigned 32-bit, same layout as
 * {@link ParsedIp}).
 */
export interface ParsedCidr extends ParsedIp {
  /** Prefix length: 0..32 for IPv4, 0..128 for IPv6. */
  readonly prefix: number;
  readonly m0: number;
  readonly m1: number;
  readonly m2: number;
  readonly m3: number;
}

// Reject "/0x10", "/ 8", "/8abc" and similar: parseInt would accept them.
// Leading zeros are refused too ("/024"), to stay consistent with the octet
// parsing rather than being strict in one place and lax in the other.
const PREFIX_RE = /^(0|[1-9]\d{0,2})$/;

const CHAR_DOT = 46;
const CHAR_COLON = 58;

// Scratch space for the IPv6 groups of the address being parsed. Parsing is
// synchronous and never re-entered, so a single module-level buffer is safe.
const groups = new Uint16Array(8);

/** Value of a hex digit, or -1 if `c` is not one. */
function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return -1;
}

/**
 * Parse a dotted-quad IPv4 address into an unsigned 32-bit integer, or -1.
 *
 * `net.isIPv4` does the validation (including the leading-zero refusal), so
 * the scan below only has to accumulate digits.
 */
function parseIPv4(ip: string): number {
  if (!net.isIPv4(ip)) {
    return -1;
  }
  let value = 0;
  let octet = 0;
  for (let i = 0; i < ip.length; i++) {
    const c = ip.charCodeAt(i);
    if (c === CHAR_DOT) {
      value = (value << 8) | octet;
      octet = 0;
    } else {
      octet = octet * 10 + (c - 48);
    }
  }
  return ((value << 8) | octet) >>> 0;
}

/**
 * Parse an IPv6 address (including `::` compression and embedded IPv4) into
 * {@link groups}. Returns false if the address is not valid.
 */
function parseIPv6Groups(ip: string): boolean {
  if (!net.isIPv6(ip)) {
    return false;
  }

  // Ignore any zone index ("fe80::1%eth0"); it plays no part in containment.
  const zone = ip.indexOf('%');
  const end = zone === -1 ? ip.length : zone;

  let count = 0; // groups read so far
  let gap = -1; // index in `groups` where "::" stands, -1 if absent
  let i = 0;

  if (end >= 2 && ip.charCodeAt(0) === CHAR_COLON && ip.charCodeAt(1) === CHAR_COLON) {
    gap = 0;
    i = 2;
  }

  while (i < end) {
    const start = i;
    let value = 0;
    let c = 0;
    while (i < end) {
      c = ip.charCodeAt(i);
      const digit = hexDigit(c);
      if (digit < 0) break;
      value = value * 16 + digit;
      i++;
    }

    if (i < end && c === CHAR_DOT) {
      // An embedded IPv4 tail ("::ffff:192.168.0.1") becomes the last two
      // groups. It must run to the end of the address.
      const v4 = parseIPv4(ip.slice(start, end));
      if (v4 < 0 || count > 6) {
        return false;
      }
      groups[count++] = v4 >>> 16;
      groups[count++] = v4 & 0xffff;
      break;
    }

    // Every group must be 1 to 4 hex digits. Reading the leading digits and
    // ignoring the rest (as parseInt does: "0gg0" became 0) could make a
    // malformed address match a range.
    const digits = i - start;
    if (digits === 0 || digits > 4 || count === 8) {
      return false;
    }
    groups[count++] = value;

    if (i === end) {
      break;
    }
    if (c !== CHAR_COLON) {
      return false;
    }
    i++;
    if (i < end && ip.charCodeAt(i) === CHAR_COLON) {
      if (gap >= 0) {
        return false; // a second "::"
      }
      gap = count;
      i++;
    } else if (i === end) {
      return false; // a trailing single ":"
    }
  }

  if (gap < 0) {
    return count === 8;
  }

  // Expand "::" by moving the groups after it to the end and zeroing the gap.
  const missing = 8 - count;
  if (missing < 0) {
    return false;
  }
  for (let k = count - 1; k >= gap; k--) {
    groups[k + missing] = groups[k];
  }
  for (let k = gap; k < gap + missing; k++) {
    groups[k] = 0;
  }
  return true;
}

/**
 * Parse an IP address of either family. Returns `null` if it is not a valid IP.
 *
 * The same strict rules apply as for a range base: leading-zero IPv4 octets
 * are refused, every IPv6 group must be 1 to 4 hex digits, a zone index is
 * ignored, and an IPv4-mapped address ("::ffff:1.2.3.4") stays IPv6. The input
 * is not trimmed.
 */
export function parseIp(ip: string): ParsedIp | null {
  if (typeof ip !== 'string') return null;
  const v4 = parseIPv4(ip);
  if (v4 >= 0) {
    return { bits: 32, w0: v4, w1: 0, w2: 0, w3: 0 };
  }
  if (parseIPv6Groups(ip)) {
    return {
      bits: 128,
      w0: ((groups[0] << 16) | groups[1]) >>> 0,
      w1: ((groups[2] << 16) | groups[3]) >>> 0,
      w2: ((groups[4] << 16) | groups[5]) >>> 0,
      w3: ((groups[6] << 16) | groups[7]) >>> 0,
    };
  }
  return null;
}

/** Mask covering the first `n` bits (clamped to 0..32) of a 32-bit word. */
function wordMask(n: number): number {
  if (n <= 0) return 0;
  if (n >= 32) return 0xffffffff;
  return (~0 << (32 - n)) >>> 0;
}

/**
 * Parse a CIDR range ("192.168.0.0/16", "2001:db8::/32"). Surrounding
 * whitespace is ignored, and a bare address without a prefix is treated as a
 * host route (/32 or /128). Host bits set in the base address are ignored.
 *
 * @throws {Error} if `cidr` is not a valid CIDR range.
 */
export function parseCidr(cidr: string): ParsedCidr {
  if (typeof cidr !== 'string') {
    throw new Error(`Invalid CIDR notation: "${String(cidr)}"`);
  }
  const trimmed = cidr.trim();
  const slash = trimmed.indexOf('/');
  if (slash !== -1 && trimmed.indexOf('/', slash + 1) !== -1) {
    throw new Error(`Invalid CIDR notation: "${cidr}"`);
  }

  const base = parseIp(slash === -1 ? trimmed : trimmed.slice(0, slash));
  if (base === null) {
    throw new Error(`Invalid CIDR notation: "${cidr}"`);
  }

  let prefix: number;
  if (slash === -1) {
    prefix = base.bits;
  } else {
    const prefixText = trimmed.slice(slash + 1);
    if (!PREFIX_RE.test(prefixText)) {
      throw new Error(`Invalid CIDR prefix length: "${cidr}"`);
    }
    prefix = Number(prefixText);
    if (prefix > base.bits) {
      throw new Error(`Invalid CIDR prefix length: "${cidr}"`);
    }
  }

  const m0 = wordMask(prefix);
  const m1 = wordMask(prefix - 32);
  const m2 = wordMask(prefix - 64);
  const m3 = wordMask(prefix - 96);
  return {
    bits: base.bits,
    w0: (base.w0 & m0) >>> 0,
    w1: (base.w1 & m1) >>> 0,
    w2: (base.w2 & m2) >>> 0,
    w3: (base.w3 & m3) >>> 0,
    prefix,
    m0,
    m1,
    m2,
    m3,
  };
}

/**
 * Test whether a parsed address falls inside a parsed range.
 *
 * Address families never cross: an IPv4 address never matches an IPv6 range
 * (and vice versa), even with a /0 prefix. Within a family, /0 matches every
 * address.
 */
export function cidrMatches(range: ParsedCidr, ip: ParsedIp): boolean {
  return (
    range.bits === ip.bits &&
    (ip.w0 & range.m0) >>> 0 === range.w0 &&
    (ip.w1 & range.m1) >>> 0 === range.w1 &&
    (ip.w2 & range.m2) >>> 0 === range.w2 &&
    (ip.w3 & range.m3) >>> 0 === range.w3
  );
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
 * This parses both arguments on every call. To test one address against
 * several ranges, use {@link parseCidr}, {@link parseIp} and {@link cidrMatches}.
 *
 * @throws {Error} if `cidr` is not a valid CIDR range or `ip` is not a valid IP.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const range = parseCidr(cidr);
  const target = parseIp(ip);
  if (target === null) {
    throw new Error(`Invalid IP address: "${ip}"`);
  }
  return cidrMatches(range, target);
}
