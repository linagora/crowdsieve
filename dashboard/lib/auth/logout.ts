/**
 * Resolve the URL the dashboard's "Sign out" link should point to, taking
 * the current AUTH_MODE into account.
 *
 * Returns null when the UI should hide the Sign-out link entirely
 * (headers mode without AUTH_LOGOUT_URL configured, or `none` mode).
 */

import { getAuthMode } from './mode';

export function getLogoutUrl(): string | null {
  const mode = getAuthMode();
  if (mode === 'oidc') return '/api/auth/logout';
  if (mode === 'headers') {
    return process.env.AUTH_LOGOUT_URL && process.env.AUTH_LOGOUT_URL.trim().length > 0
      ? '/api/auth/logout'
      : null;
  }
  return null;
}

/** Return the configured external logout URL, trimmed, or null. */
export function getExternalLogoutUrl(): string | null {
  const raw = process.env.AUTH_LOGOUT_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Return the configured external login URL (used by the headers-mode 401 page), or null. */
export function getExternalLoginUrl(): string | null {
  const raw = process.env.AUTH_LOGIN_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}
