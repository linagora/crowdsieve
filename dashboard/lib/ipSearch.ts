/**
 * Parsing and matching of the alert list "Search IP" value: an IPv4 or IPv6
 * address, or a CIDR range.
 *
 * This runs in the browser, so it cannot reuse `src/filters/cidr.ts` (built
 * on `node:net`). The proxy validates the value again and does the real
 * search; the matching below only hides, while a new list is loading, the
 * alerts the proxy is sure not to return.
 */

/** A parsed address or range: eight 16-bit groups (IPv4 uses the first two). */
interface ParsedAddress {
  bits: 32 | 128;
  groups: number[];
}

export interface IpSearch {
  /** Normalised text sent as `ip` to the API and kept in the URL. */
  value: string;
  /** Whether the value is a CIDR range rather than a single address. */
  isRange: boolean;
  bits: 32 | 128;
  groups: number[];
  /** Prefix length; the address width (32 or 128) for a single address. */
  prefix: number;
}

export const INVALID_IP_SEARCH_MESSAGE = 'Enter a valid IPv4 or IPv6 address';

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
// Characters an IPv6 address may contain (zone indexes are not accepted).
const IPV6_CHARS_RE = /^[0-9a-fA-F:.]+$/;
const PREFIX_RE = /^(0|[1-9]\d{0,2})$/;

function parseIPv4(text: string): ParsedAddress | null {
  if (!IPV4_RE.test(text)) return null;
  const [a, b, c, d] = text.split('.').map(Number);
  return { bits: 32, groups: [(a << 8) | b, (c << 8) | d, 0, 0, 0, 0, 0, 0] };
}

function parseIPv6(text: string): ParsedAddress | null {
  if (!text.includes(':') || !IPV6_CHARS_RE.test(text)) return null;
  // The URL parser validates IPv6 hosts and serialises them in a canonical
  // form: lower-case hex groups, at most one "::", no embedded IPv4.
  let host: string;
  try {
    host = new URL(`http://[${text}]/`).hostname;
  } catch {
    return null;
  }
  const canonical = host.replace(/^\[|\]$/g, '');
  const [head, tail] = canonical.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right].map((g) =>
    parseInt(g, 16)
  );
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return { bits: 128, groups };
}

function parseAddress(text: string): ParsedAddress | null {
  return parseIPv4(text) ?? parseIPv6(text);
}

/**
 * Parse a "Search IP" value. Returns null for an empty or invalid value.
 * Surrounding whitespace is ignored and the value is lower-cased (IPv6 hex
 * digits are stored lower-case).
 */
export function parseIpSearch(input: string | null | undefined): IpSearch | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const parts = text.split('/');
  if (parts.length > 2) return null;
  const address = parseAddress(parts[0]);
  if (!address) return null;

  if (parts.length === 1) {
    return { value: text, isRange: false, ...address, prefix: address.bits };
  }
  if (!PREFIX_RE.test(parts[1])) return null;
  const prefix = Number(parts[1]);
  if (prefix > address.bits) return null;
  return { value: text, isRange: true, ...address, prefix };
}

/** Whether the first `prefix` bits of two parsed addresses are equal. */
function samePrefix(a: number[], b: number[], prefix: number): boolean {
  for (let i = 0; i < 8; i++) {
    const remaining = prefix - i * 16;
    if (remaining <= 0) return true;
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

/** Whether a stored address or range lies inside the searched range. */
function storedValueInRange(search: IpSearch, value: string | null | undefined): boolean {
  if (!value) return false;
  const stored = parseIpSearch(value);
  if (!stored || stored.bits !== search.bits || stored.prefix < search.prefix) return false;
  return samePrefix(stored.groups, search.groups, search.prefix);
}

/**
 * Client-side equivalent of the proxy's `ip` filter: a single address matches
 * `sourceIp` / `sourceValue` exactly (case-insensitively, so it never hides
 * an alert the API returns); a range matches when one of `sourceIp`,
 * `sourceValue` or `sourceRange` lies inside it.
 */
export function alertMatchesIpSearch(
  search: IpSearch,
  alert: { sourceIp?: string | null; sourceValue?: string | null; sourceRange?: string | null }
): boolean {
  if (!search.isRange) {
    return (
      alert.sourceIp?.toLowerCase() === search.value ||
      alert.sourceValue?.toLowerCase() === search.value
    );
  }
  return (
    storedValueInRange(search, alert.sourceIp) ||
    storedValueInRange(search, alert.sourceValue) ||
    storedValueInRange(search, alert.sourceRange)
  );
}
