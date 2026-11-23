import { getIronSession, IronSession } from 'iron-session';
import { cookies, headers } from 'next/headers';
import { getActorClaim, getSessionSecret } from './config';
import { isSessionRevoked } from './revocation';
import { isLiveSession, SESSION_COOKIE_NAME } from './session-cookie';
import { getAuthMode } from '../auth/mode';
import { parseAuthHeaders } from '../auth/headers';
import { checkTrustedUpstream } from '../auth/trust';
import { roleFromHeaders, roleFromSession, type UserRole } from '../auth/roles';

/**
 * SessionUser carries the minimal identity claims used by the dashboard.
 *
 * The known fields (`sub`, `email`, `name`, `picture`) are populated by the
 * OIDC flow. The headers-auth mode can add arbitrary additional claims (e.g.
 * `familyName`, `givenName`, `preferredUsername`) via the index signature —
 * these are surfaced to consumers like UserMenu and `resolveActor`.
 */
export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  /** Arbitrary additional claims (used by headers mode). */
  [claim: string]: string | undefined;
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
  /**
   * Role computed at sign-in from the user's groups (see lib/auth/roles.ts).
   * Missing in sessions sealed before roles existed.
   */
  role?: UserRole;
  /** The user's groups that granted the Operator role at sign-in. */
  operatorGroups?: string[];
  // Temporary OIDC state for callback verification (cleared after use)
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  /** Validated path (pathname + query string) to return to after sign-in */
  redirect?: string;
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
  cookieName: SESSION_COOKIE_NAME,
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

/**
 * Resolve the current SessionUser. In OIDC mode this reads the iron-session
 * cookie; in headers mode it reads the per-request `Auth-*` headers.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (getAuthMode() === 'headers') {
    const h = await headers();
    return parseAuthHeaders(h);
  }
  const session = await getSession();
  return session.user ?? null;
}

/**
 * Role of the current request (see lib/auth/roles.ts):
 *   - 'none' mode: always 'operator';
 *   - 'headers' mode: from the groups header, only once the request passed
 *     the trusted-upstream checks and carries an `Auth-Sub`;
 *   - 'oidc' mode: from the role stored in a live session cookie.
 * Anything that is not an authenticated request gets 'viewer'. This does
 * not replace `isSessionValid()`: call `requireAuth()` first in routes.
 */
export async function getSessionRole(): Promise<UserRole> {
  const mode = getAuthMode();
  if (mode === 'none') return 'operator';

  if (mode === 'headers') {
    const h = await headers();
    if (!checkTrustedUpstream(h).ok || parseAuthHeaders(h) === null) return 'viewer';
    return roleFromHeaders(h);
  }

  let session: IronSession<SessionData>;
  try {
    session = await getSession();
  } catch {
    // Unusable cookie or SESSION_SECRET: no session, no write access.
    return 'viewer';
  }
  if (!isLiveSession(session)) return 'viewer';
  return roleFromSession(session);
}

/**
 * Whether the current request carries a valid session.
 *
 * - Headers mode: the request must come from a trusted upstream (see
 *   `lib/auth/trust.ts`) and carry a non-empty `Auth-Sub`.
 * - OIDC mode: the iron-session cookie must hold a signed-in user (`user`),
 *   an `expiresAt` in the future, and must not have been revoked through
 *   back-channel logout.
 *
 * A cookie that cannot be unsealed is treated as no session. Errors about a
 * missing or too short SESSION_SECRET are propagated so that callers can
 * report the misconfiguration.
 */
export async function isSessionValid(): Promise<boolean> {
  if (getAuthMode() === 'headers') {
    const h = await headers();
    if (!checkTrustedUpstream(h).ok) return false;
    return parseAuthHeaders(h) !== null;
  }

  // Resolve the secret first so that a misconfiguration is not mistaken for
  // a bad cookie below.
  getSessionSecret();

  let session: IronSession<SessionData>;
  try {
    session = await getSession();
  } catch {
    // Cookie that iron-session cannot parse: no valid session.
    return false;
  }
  if (!isLiveSession(session)) {
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
 * Resolve the audit-log "actor" string for a session user using the
 * configured actor claim (`AUTH_ACTOR_CLAIM` or `OIDC_ACTOR_CLAIM`,
 * defaults to `sub`). Falls back to `sub` when the configured claim is
 * missing or whitespace-only on the user. Returns an empty string when the
 * user is null/undefined.
 *
 * Supports arbitrary claim names so headers-mode-only fields like
 * `familyName` or `preferredUsername` work seamlessly.
 */
export function resolveActor(user: SessionUser | null | undefined): string {
  if (!user) return '';
  const claim = getActorClaim();
  const value = user[claim];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return user.sub.trim();
}
