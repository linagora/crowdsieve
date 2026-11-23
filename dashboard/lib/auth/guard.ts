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
import { isSessionValid } from '../oidc/session';

/**
 * Check the session of the current request for the configured auth mode:
 *   - 'none'    : always allowed;
 *   - 'headers' : trusted upstream and a non-empty `Auth-Sub`;
 *   - 'oidc'    : signed-in, unexpired, non-revoked iron-session cookie.
 *
 * Returns null when the request may proceed, or the response to send back
 * (401 JSON) otherwise. Usage:
 *
 *   const denied = await requireAuth();
 *   if (denied) return denied;
 */
export async function requireAuth(): Promise<NextResponse | null> {
  if (getAuthMode() === 'none') return null;

  try {
    if (await isSessionValid()) return null;
  } catch (error) {
    console.error('Session validation error:', error);
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    console.error('Session validation error:', error);
  }
  // redirect() throws: keep it outside the try block.
  if (!valid) {
    redirect('/login');
  }
}
