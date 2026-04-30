/**
 * Authentication mode resolution.
 *
 * Three modes are supported:
 *   - 'oidc'    : OIDC (iron-session backed) — existing behavior.
 *   - 'headers' : Trusted upstream proxy forwards identity via Auth-* headers.
 *   - 'none'    : No authentication enforced (dashboard is wide open).
 *
 * Behavior when AUTH_MODE is unset:
 *   - 'oidc' if both OIDC_ISSUER and OIDC_CLIENT_ID are set.
 *   - 'none' otherwise (matches the historical default).
 *
 * NOTE: This module must remain Edge-Runtime-compatible. Do not import any
 * Node.js-only API (no fs, no crypto, no next/headers).
 */

export type AuthMode = 'oidc' | 'headers' | 'none';

export function getAuthMode(): AuthMode {
  const explicit = process.env.AUTH_MODE?.trim().toLowerCase();
  if (explicit === 'oidc' || explicit === 'headers' || explicit === 'none') {
    // Note: an explicit `AUTH_MODE=oidc` with missing OIDC_ISSUER /
    // OIDC_CLIENT_ID is a misconfiguration. We honor the explicit choice and
    // let the /login page render a clear configuration error — returning
    // 'none' here would silently disable auth, which is worse.
    return explicit;
  }
  // Auto-detect: enable OIDC if it's configured, otherwise no auth.
  const oidcConfigured = !!(process.env.OIDC_ISSUER?.trim() && process.env.OIDC_CLIENT_ID?.trim());
  return oidcConfigured ? 'oidc' : 'none';
}

export function isHeadersAuthEnabled(): boolean {
  return getAuthMode() === 'headers';
}

export function isOidcAuthEnabled(): boolean {
  return getAuthMode() === 'oidc';
}
