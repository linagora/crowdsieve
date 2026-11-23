/**
 * Trusted-upstream checks for headers authentication mode.
 *
 * In headers mode the identity comes from `Auth-*` request headers, so the
 * dashboard must only accept them from the authenticating proxy. Two
 * optional controls are available on top of network isolation:
 *
 * 1. `AUTH_PROXY_SECRET` (recommended): a shared secret that the proxy adds
 *    to every request in the `X-Auth-Proxy-Secret` header. Requests without
 *    the exact value are rejected (constant-time comparison).
 *
 * 2. `TRUSTED_PROXY_IPS`: an allowlist checked against the RIGHT-MOST entry
 *    of `X-Forwarded-For`, i.e. the address appended by the closest proxy.
 *    LIMITATION: the Next.js server only sets `X-Forwarded-For` to the socket
 *    address when the request has no such header; it does not append to a
 *    header sent by the client. A client that reaches the dashboard directly
 *    can therefore send `X-Forwarded-For: <trusted IP>` and pass this check.
 *    It only filters requests that come through a proxy that appends to the
 *    header, and is NOT a protection against direct access.
 *
 * Format of TRUSTED_PROXY_IPS: comma-separated list of IPv4 addresses, IPv6
 * addresses, or IPv4 CIDR ranges. IPv6 CIDR ranges are matched as exact
 * strings only in v1 (a hand-rolled IPv6 prefix matcher is overkill for this
 * use case).
 *
 * This module must remain Edge-Runtime-compatible (no node:crypto).
 */

/** Header in which the authenticating proxy sends AUTH_PROXY_SECRET. */
export const AUTH_PROXY_SECRET_HEADER = 'x-auth-proxy-secret';

/** Return AUTH_PROXY_SECRET, or null when unset or blank. */
export function getAuthProxySecret(): string | null {
  const raw = process.env.AUTH_PROXY_SECRET;
  if (!raw || raw.trim().length === 0) return null;
  return raw;
}

/**
 * Compare a provided value with the expected secret in constant time with
 * respect to the content of the provided value: the loop always runs over
 * the whole expected secret, and a length mismatch only changes the result.
 * Edge-compatible replacement for node:crypto timingSafeEqual.
 */
export function constantTimeEqual(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (i < a.length ? a[i] : 0) ^ b[i];
  }
  return diff === 0;
}

/**
 * Whether the request carries the configured AUTH_PROXY_SECRET. Returns true
 * when no secret is configured.
 */
export function hasValidProxySecret(headers: Headers): boolean {
  const expected = getAuthProxySecret();
  if (expected === null) return true;
  const provided = headers.get(AUTH_PROXY_SECRET_HEADER);
  if (provided === null) return false;
  return constantTimeEqual(provided, expected);
}

export type UpstreamCheck = { ok: true } | { ok: false; reason: 'proxy-secret' | 'untrusted-ip' };

/**
 * Check that a headers-mode request comes from the trusted upstream proxy:
 * AUTH_PROXY_SECRET first (when set), then TRUSTED_PROXY_IPS (when set).
 */
export function checkTrustedUpstream(headers: Headers): UpstreamCheck {
  if (!hasValidProxySecret(headers)) {
    return { ok: false, reason: 'proxy-secret' };
  }
  if (!isTrustedProxy(getClientIp({ headers }))) {
    return { ok: false, reason: 'untrusted-ip' };
  }
  return { ok: true };
}

/** Read TRUSTED_PROXY_IPS from env, return parsed entries (no validation). */
export function getTrustedProxyIps(): string[] {
  const raw = process.env.TRUSTED_PROXY_IPS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parse an IPv4 dotted-quad into a 32-bit unsigned integer, or null. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    // Reject leading zeros: "010" is ambiguous (octal in some parsers, 10 in
    // others), so it must not be accepted as an IPv4 octet.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    // Use unsigned shift to keep a 32-bit semantic.
    result = (result * 256 + n) >>> 0;
  }
  return result >>> 0;
}

/** Check whether `ip` falls inside a CIDR like `192.168.0.0/16`. */
function matchIPv4Cidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const network = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) return false;

  const ipInt = parseIPv4(ip);
  const netInt = parseIPv4(network);
  if (ipInt === null || netInt === null) return false;

  if (prefix === 0) return true;
  // Build a /prefix mask. Avoid the `1 << 32` overflow by special-casing 32.
  const mask = prefix === 32 ? 0xffffffff : ~((1 << (32 - prefix)) - 1) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/**
 * Canonicalize an IP for exact-match comparison.
 *
 * IPv4 is only lowercased (its dotted form has no case). IPv6 goes through the
 * WHATWG URL parser, which returns the RFC 5952 compressed form and rejects
 * invalid input. IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`,
 * `0:0:0:0:0:ffff:1.2.3.4`, `::ffff:102:304`) are mapped to the dotted IPv4
 * form so that exact matches work across spellings.
 */
function normalizeIp(ip: string): string {
  let n = ip.trim();
  if (n.startsWith('[') && n.endsWith(']')) {
    n = n.slice(1, -1);
  }
  // Leave IPv4 (and IPv4 CIDR) alone: the URL parser would reinterpret
  // leading-zero octets as octal.
  if (!n.includes(':')) return n.toLowerCase();

  let canonical: string;
  try {
    // The WHATWG hostname is bracketed and lowercased, e.g. "[::ffff:a00:1]".
    canonical = new URL(`http://[${n}]/`).hostname.slice(1, -1);
  } catch {
    return n.toLowerCase();
  }

  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return canonical;
}

/**
 * Return true iff `clientIp` is trusted to send Auth-* headers:
 * - When the trust list is empty, trust is implicit (operator decision: rely
 *   on network isolation only).
 * - Otherwise, the IP must match an entry exactly OR fall inside an IPv4 CIDR.
 */
export function isTrustedProxy(clientIp: string | null): boolean {
  const trusted = getTrustedProxyIps();
  if (trusted.length === 0) return true;
  if (!clientIp) return false;

  const normalized = normalizeIp(clientIp);

  for (const entry of trusted) {
    const normEntry = normalizeIp(entry);
    if (normEntry.includes('/')) {
      if (matchIPv4Cidr(normalized, normEntry)) return true;
    } else if (normEntry === normalized) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the address of the closest hop for TRUSTED_PROXY_IPS: the
 * right-most non-empty entry of `X-Forwarded-For`. Entries on the left are
 * written by the client and earlier proxies, and are never used.
 *
 * The Next.js server fills `X-Forwarded-For` with the socket address only
 * when the request has none, so without a proxy the right-most entry is
 * either the real peer or a value forged by the client: see the module
 * comment. `X-Real-IP` is not used, as a client can set it as well.
 *
 * Returns null when no address can be determined.
 */
export function getClientIp(request: { headers: Headers }): string | null {
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return null;
  const entries = xff
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}
