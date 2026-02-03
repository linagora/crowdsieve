/**
 * Security validation utilities for OIDC authentication
 */

// Regex to detect URL schemes (e.g., http:, https:, javascript:, data:)
const UNSAFE_URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Validate redirect path to prevent open redirect attacks.
 *
 * SECURITY: This function ensures that redirect paths are:
 * - Relative paths starting with /
 * - Not protocol-relative URLs (//example.com)
 * - Not absolute URLs with schemes (http:, javascript:, data:, etc.)
 *
 * @param path - The path to validate
 * @returns true if the path is safe for redirect, false otherwise
 */
export function isSafeRedirect(path: string | undefined): path is string {
  if (!path) return false;
  // Reject any path that starts with a URL scheme
  if (UNSAFE_URL_SCHEME.test(path)) return false;
  // Must start with / (relative path) and not // (protocol-relative URL)
  return path.startsWith('/') && !path.startsWith('//');
}

/**
 * Logout token claims structure per OpenID Connect Back-Channel Logout spec
 */
export interface LogoutTokenClaims {
  iss: string;
  sub?: string;
  aud: string | string[];
  iat: number;
  jti: string;
  sid?: string;
  events: {
    'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
  };
  nonce?: string;
}

export interface LogoutTokenValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate logout token claims per OpenID Connect Back-Channel Logout spec.
 *
 * SECURITY: This validates the token structure AFTER JWT signature verification.
 * The spec requires:
 * - Must contain the backchannel-logout event
 * - Must NOT contain a nonce claim
 * - Must contain either sub or sid (or both)
 *
 * @param claims - The decoded JWT claims
 * @returns Validation result with error message if invalid
 */
export function validateLogoutTokenClaims(
  claims: Partial<LogoutTokenClaims>
): LogoutTokenValidationResult {
  // Must contain the backchannel-logout event
  if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
    return { valid: false, error: 'missing backchannel-logout event' };
  }

  // Must NOT contain a nonce claim (per spec)
  if (claims.nonce !== undefined) {
    return { valid: false, error: 'logout token must not contain nonce' };
  }

  // Must contain sub or sid (or both)
  if (!claims.sub && !claims.sid) {
    return { valid: false, error: 'logout token must contain sub or sid' };
  }

  return { valid: true };
}
