import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { getSessionSecret } from './config';
import { isSessionRevoked } from './revocation';

export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface SessionData {
  user?: SessionUser;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  // Session ID from OIDC (for back-channel logout)
  sid?: string;
  // OIDC state/nonce for verification during callback
  state?: string;
  nonce?: string;
  codeVerifier?: string;
}

const SESSION_OPTIONS = {
  cookieName: 'crowdsieve-session',
  password: '', // Will be set dynamically
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
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
