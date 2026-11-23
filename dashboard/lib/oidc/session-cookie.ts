/**
 * Edge-compatible helpers to read and check the OIDC session cookie.
 *
 * The middleware runs in the Edge Runtime, so it cannot use `next/headers`
 * nor the in-memory revocation store of the Node.js server. It unseals the
 * iron-session cookie itself with `unsealData` (iron-session uses WebCrypto
 * through `uncrypto` on the Edge) and checks that it carries a signed-in,
 * unexpired session. Route handlers and server pages add the back-channel
 * revocation check on top (see `isSessionValid()` in `./session`).
 *
 * This module must remain Edge-Runtime-compatible: no Node.js-only API and
 * no runtime import of `./session` (which pulls `next/headers`).
 */

import { unsealData } from 'iron-session';
import { getSessionSecret } from './config';
import type { SessionData, SessionUser } from './session';

/** Name of the iron-session cookie that holds the OIDC session. */
export const SESSION_COOKIE_NAME = 'crowdsieve-session';

/** A session that belongs to a signed-in user and carries its expiry. */
export type LiveSessionData = SessionData & { user: SessionUser; expiresAt: number };

/**
 * Whether the unsealed session data belongs to a signed-in user and has not
 * expired. A session saved by `/api/auth/login` (which only holds the
 * `state`, `nonce` and `codeVerifier` of a login in progress) has no `user`
 * and is rejected, as is a session without a numeric `expiresAt`.
 */
export function isLiveSession(
  data: SessionData | null | undefined,
  now: number = Date.now()
): data is LiveSessionData {
  if (!data || typeof data !== 'object') return false;
  const user = data.user;
  if (!user || typeof user !== 'object') return false;
  if (typeof user.sub !== 'string' || user.sub.trim().length === 0) return false;
  const expiresAt = data.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return now < expiresAt;
}

/**
 * Unseal the value of the session cookie. Returns null when the cookie is
 * missing, cannot be unsealed with the configured secret (forged, tampered,
 * sealed with another secret, or expired seal), or when no usable session
 * secret is configured. Never throws.
 */
export async function unsealSessionCookie(
  value: string | null | undefined
): Promise<SessionData | null> {
  if (!value) return null;

  let password: string;
  try {
    password = getSessionSecret();
  } catch {
    // Misconfigured secret: fail closed. The error is logged by
    // getSessionSecret() and surfaced by the auth routes and login page.
    return null;
  }

  try {
    const data = await unsealData<SessionData>(value, { password });
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
