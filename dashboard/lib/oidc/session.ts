import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { getActorClaim, getSessionSecret } from './config';
import { isSessionRevoked } from './revocation';

export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * SessionData is stored in an encrypted httpOnly cookie via iron-session.
 *
 * SECURITY CONSIDERATIONS:
 * - All data in this interface is stored client-side (in the encrypted cookie)
 * - If SESSION_SECRET is compromised, tokens could be decrypted
 * - For higher security requirements, consider storing tokens server-side
 *   (in a database) and keeping only a session ID in the cookie
 * - Tokens are cleared from the session once no longer needed
 * - Session expiration is enforced on every request via isSessionValid()
 */
export interface SessionData {
  user?: SessionUser;
  /** Access token from OIDC provider - stored client-side in encrypted cookie */
  accessToken?: string;
  /** ID token (JWT) containing identity claims - treat as sensitive */
  idToken?: string;
  /** Refresh token - highly sensitive, consider server-side storage for production */
  refreshToken?: string;
  expiresAt?: number;
  /** Session ID from OIDC provider (for back-channel logout support) */
  sid?: string;
  // Temporary OIDC state for callback verification (cleared after use)
  state?: string;
  nonce?: string;
  codeVerifier?: string;
}

// Determine if cookies should be secure (HTTPS only)
// Can be overridden via SESSION_COOKIE_SECURE env var for reverse proxy setups
function isSecureCookie(): boolean {
  const envValue = process.env.SESSION_COOKIE_SECURE;
  if (envValue !== undefined) {
    return envValue === 'true' || envValue === '1';
  }
  return process.env.NODE_ENV === 'production';
}

const SESSION_OPTIONS = {
  cookieName: 'crowdsieve-session',
  password: '', // Will be set dynamically
  cookieOptions: {
    secure: isSecureCookie(),
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 7, // 1 week
  },
};

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, {
    ...SESSION_OPTIONS,
    password: getSessionSecret(),
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session.user ?? null;
}

export async function isSessionValid(): Promise<boolean> {
  const session = await getSession();
  if (!session.user) {
    return false;
  }
  // Check if session has expired
  if (session.expiresAt && Date.now() > session.expiresAt) {
    return false;
  }
  // Check if session has been revoked via back-channel logout
  if (isSessionRevoked(session.sid, session.user.sub)) {
    return false;
  }
  return true;
}

export async function clearSession(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

/**
 * Resolve the audit-log "actor" string for a session user using the configured
 * OIDC claim (OIDC_ACTOR_CLAIM, defaults to "sub"). Falls back to "sub" when
 * the configured claim is missing on the user (e.g. provider didn't return an
 * email). Returns an empty string when the user is null.
 */
export function resolveActor(user: SessionUser | null | undefined): string {
  if (!user) return '';
  const claim = getActorClaim();
  const value = user[claim];
  if (value && value.trim().length > 0) return value;
  return user.sub;
}
