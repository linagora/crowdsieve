/**
 * Server-side authentication guards for route handlers and server pages.
 *
 * The middleware is the first gate, but it runs in the Edge Runtime and
 * cannot see the in-memory back-channel revocation store. Every API route
 * (except `/api/auth/*` and `/api/jwks`) and every server page that fetches
 * data MUST call one of these guards before doing any work.
 *
 * This module runs in the Node.js runtime only (it uses `next/headers`).
 */

import { NextResponse } from 'next/server';
import { redirect } from 'next/navigation';
import { getAuthMode } from './mode';
import { getSessionRole, isSessionValid } from '../oidc/session';
import { getSessionSecret, SessionSecretError } from '../oidc/config';
import { READ_ONLY_ERROR, type UserRole } from './roles';

/**
 * Check the session of the current request for the configured auth mode:
 *   - 'none'    : always allowed;
 *   - 'headers' : trusted upstream and a non-empty `Auth-Sub`;
 *   - 'oidc'    : signed-in, unexpired, non-revoked iron-session cookie.
 *
 * Returns null when the request may proceed, or the response to send back
 * otherwise: 401 JSON, or 500 JSON when SESSION_SECRET is not usable in OIDC
 * mode. Usage:
 *
 *   const denied = await requireAuth();
 *   if (denied) return denied;
 */
export async function requireAuth(): Promise<NextResponse | null> {
  if (getAuthMode() === 'none') return null;

  try {
    if (await isSessionValid()) return null;
  } catch (error) {
    if (error instanceof SessionSecretError) {
      // Already logged by getSessionSecret().
      return NextResponse.json(
        { error: `Server misconfiguration: ${error.message}` },
        { status: 500 }
      );
    }
    console.error('Session validation error:', error);
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Guard for the routes that change something (ban, unban, analyzer run...):
 * `requireAuth()`, then the Operator role (see lib/auth/roles.ts). A signed-in
 * Viewer gets 403 `{"error":"Your account is read-only"}`, before anything is
 * sent to the proxy. Usage, in place of requireAuth():
 *
 *   const denied = (await requireOperator()) ?? requireJsonContentType(request);
 *   if (denied) return denied;
 */
export async function requireOperator(): Promise<NextResponse | null> {
  const denied = await requireAuth();
  if (denied) return denied;

  let role: UserRole = 'viewer';
  try {
    role = await getSessionRole();
  } catch (error) {
    console.error('Role resolution error:', error);
  }
  if (role === 'operator') return null;
  return NextResponse.json({ error: READ_ONLY_ERROR }, { status: 403 });
}

/**
 * For the OIDC auth routes (login, callback): return a plain-text 500 when
 * SESSION_SECRET is missing or too short in production, null otherwise.
 */
export function checkSessionSecret(): NextResponse | null {
  try {
    getSessionSecret();
    return null;
  } catch (error) {
    if (!(error instanceof SessionSecretError)) throw error;
    return new NextResponse(`Server misconfiguration: ${error.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * CSRF defence for routes that read a JSON body: require
 * `Content-Type: application/json` (optionally with parameters such as
 * charset). An HTML form cannot send it, and a cross-origin fetch() that
 * sets it needs a CORS preflight, which the dashboard does not grant.
 * Returns a 415 JSON response when the request does not qualify.
 */
export function requireJsonContentType(request: Request): NextResponse | null {
  const contentType = request.headers.get('content-type');
  const mediaType = contentType?.split(';')[0].trim().toLowerCase();
  if (mediaType === 'application/json') return null;
  return NextResponse.json(
    { error: 'Unsupported Media Type: Content-Type must be application/json' },
    { status: 415 }
  );
}

/**
 * Guard for server pages: redirect to /login when the current request does
 * not carry a valid session. Does nothing in 'none' mode.
 */
export async function requirePageAuth(): Promise<void> {
  if (getAuthMode() === 'none') return;

  let valid = false;
  try {
    valid = await isSessionValid();
  } catch (error) {
    // A SessionSecretError is already logged; /login explains it.
    if (!(error instanceof SessionSecretError)) {
      console.error('Session validation error:', error);
    }
  }
  // redirect() throws: keep it outside the try block.
  if (!valid) {
    redirect('/login');
  }
}
