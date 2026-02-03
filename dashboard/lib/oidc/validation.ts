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
