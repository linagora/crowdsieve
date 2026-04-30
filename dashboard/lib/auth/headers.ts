/**
 * HTTP-headers authentication mode.
 *
 * Identity is forwarded by an upstream proxy (LemonLDAP-NG handler, NGINX
 * auth_request, Apache mod_auth_*, etc.) as `Auth-<Field>` headers. We map
 * each `Auth-Foo-Bar-Baz` header to a `fooBarBaz` claim on the SessionUser.
 *
 * SECURITY NOTES:
 * - This module trusts the headers it receives. Operators MUST place the
 *   dashboard behind a proxy that strips client-supplied Auth-* headers and
 *   only adds verified ones. See `lib/auth/trust.ts` for IP-based gating.
 * - Header values are sanitized (CRLF stripped, length capped, non-string
 *   skipped) but NOT cryptographically validated.
 * - `picture` is restricted to http/https URLs to prevent XSS via
 *   `javascript:` / `data:` URIs.
 *
 * This module must remain Edge-Runtime-compatible.
 */

import type { SessionUser } from '../oidc/session';

/** Header prefix (lowercase: Next.js Headers normalize names to lowercase). */
export const HEADER_PREFIX = 'auth-';

/** Maximum length for any single header value (defensive). */
const MAX_VALUE_LENGTH = 1024;

/**
 * Convert a kebab-case suffix (e.g. `family-name`) to camelCase (`familyName`).
 * Empty input returns empty string.
 */
function kebabToCamel(input: string): string {
  return input.toLowerCase().replace(/-(.)/g, (_, c: string) => c.toUpperCase());
}

/**
 * Sanitize a single header value:
 * - Trim leading/trailing whitespace.
 * - Remove CR/LF (defense against header smuggling if the header somehow
 *   came from an untrusted source despite IP gating).
 * - Truncate to MAX_VALUE_LENGTH.
 * Returns null when the result is empty.
 */
function sanitizeValue(raw: string): string | null {
  const cleaned = raw.replace(/[\r\n]/g, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_VALUE_LENGTH ? cleaned.slice(0, MAX_VALUE_LENGTH) : cleaned;
}

/**
 * Validate that a picture URL uses http/https. Mirrors the check in
 * `components/UserMenu.tsx` (`isValidPictureUrl`).
 */
function isValidPictureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Iterate over a Headers instance or a plain header bag in a uniform way.
 * For multi-value headers (string[]), we join with comma per RFC 7230 §3.2.2.
 */
function* iterEntries(
  headers: Headers | Record<string, string | string[] | undefined>
): Generator<[string, string]> {
  if (typeof (headers as Headers).forEach === 'function' && headers instanceof Headers) {
    for (const [name, value] of headers.entries()) {
      yield [name.toLowerCase(), value];
    }
    return;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(bag)) {
    if (value === undefined) continue;
    yield [name.toLowerCase(), Array.isArray(value) ? value.join(',') : value];
  }
}

/**
 * Parse the `Auth-*` headers into a SessionUser, or return null when the
 * required `Auth-Sub` is missing/empty.
 */
export function parseAuthHeaders(
  headers: Headers | Record<string, string | string[] | undefined>
): SessionUser | null {
  const claims: Record<string, string> = {};

  for (const [name, value] of iterEntries(headers)) {
    if (!name.startsWith(HEADER_PREFIX)) continue;
    const suffix = name.slice(HEADER_PREFIX.length);
    if (suffix.length === 0) continue;

    const sanitized = sanitizeValue(value);
    if (sanitized === null) continue;

    const claim = kebabToCamel(suffix);
    if (claim.length === 0) continue;

    if (claim === 'picture' && !isValidPictureUrl(sanitized)) {
      // Skip unsafe picture URLs (javascript:, data:, etc.).
      continue;
    }

    claims[claim] = sanitized;
  }

  const sub = claims.sub;
  if (!sub || sub.trim().length === 0) {
    return null;
  }

  // Build the SessionUser. `sub` is required; everything else is opportunistic.
  const user: SessionUser = { sub };
  for (const [k, v] of Object.entries(claims)) {
    if (k === 'sub') continue;
    user[k] = v;
  }
  return user;
}
