/**
 * Trusted-proxy IP gating for headers authentication mode.
 *
 * When `TRUSTED_PROXY_IPS` is set, the middleware rejects requests whose
 * source IP is not in the allowlist. This is a defense-in-depth measure on
 * top of network-level isolation (the dashboard SHOULD be unreachable except
 * via the trusted upstream proxy).
 *
 * Format: comma-separated list of IPv4 addresses, IPv6 addresses, or
 * IPv4 CIDR ranges. IPv6 CIDR ranges are matched as exact strings only in
 * v1 (a hand-rolled IPv6 prefix matcher is overkill for this use case).
 *
 * This module must remain Edge-Runtime-compatible.
 */

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
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
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
 * Lightly normalize an IP for exact-match comparison: lowercase (for IPv6
 * hex digits), strip surrounding brackets if present.
 */
function normalizeIp(ip: string): string {
  let n = ip.trim().toLowerCase();
  if (n.startsWith('[') && n.endsWith(']')) {
    n = n.slice(1, -1);
  }
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — normalize to the IPv4 form so that
  // exact matches against an IPv4 entry work even when the request comes via
  // a dual-stack socket.
  const v4MappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(n);
  if (v4MappedMatch) return v4MappedMatch[1];
  return n;
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
 * Resolve the client IP for trust-checking purposes. Order:
 *  1. NextRequest.ip (only present in some Next.js runtimes).
 *  2. X-Forwarded-For first entry.
 *  3. X-Real-IP.
 * Returns null if none can be determined.
 */
export function getClientIp(
  request: Request | { ip?: string | null; headers: Headers }
): string | null {
  const reqWithIp = request as { ip?: string | null };
  if (typeof reqWithIp.ip === 'string' && reqWithIp.ip.length > 0) {
    return reqWithIp.ip;
  }

  const headers = (request as { headers: Headers }).headers;
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    // First non-empty entry wins.
    for (const entry of xff.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  const xri = headers.get('x-real-ip');
  if (xri && xri.trim().length > 0) {
    return xri.trim();
  }

  return null;
}
