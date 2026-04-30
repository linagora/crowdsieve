import { NextRequest, NextResponse } from 'next/server';
import { isSafeRedirect } from '@/lib/oidc/validation';

/**
 * SECURITY: Middleware for the dashboard's authentication gate.
 *
 * Runs in the Edge Runtime, so we MUST avoid any Node-only API (no fs,
 * no crypto, no `next/headers`). Helper logic is inlined or imported from
 * Edge-compatible modules in `lib/auth/`.
 *
 * Three modes are supported (selected via AUTH_MODE or auto-detected):
 *   - 'none'    : allow everything.
 *   - 'oidc'    : check the iron-session cookie, redirect to /login when absent.
 *   - 'headers' : require a valid `Auth-Sub` header from a trusted upstream.
 *
 * Edge runtime caveat: full session validation (expiration, revocation) for
 * OIDC mode happens in page/API routes — middleware only checks cookie
 * presence as a first gate (defense in depth).
 */

import { getAuthMode } from '@/lib/auth/mode';
import { getClientIp, isTrustedProxy } from '@/lib/auth/trust';
import { parseAuthHeaders } from '@/lib/auth/headers';

// Public paths that don't require authentication
// SECURITY: Be careful adding paths - they bypass authentication
// Note: favicon.ico and _next/static are handled by the matcher config below
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/auth/session',
  '/api/auth/backchannel-logout',
  '/api/jwks', // JWKS endpoint for OIDC provider to get our encryption keys
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'));
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const mode = getAuthMode();

  // 'none': no auth — allow everything (current behavior pre-headers-mode).
  if (mode === 'none') {
    return NextResponse.next();
  }

  // Allow public paths in both 'oidc' and 'headers' modes. In headers mode,
  // /login renders a static "Authentication required" page that does NOT
  // initiate any login flow.
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (mode === 'headers') {
    // Defense-in-depth: optionally restrict by the source IP of the
    // immediate caller. When TRUSTED_PROXY_IPS is unset, we trust the
    // network layer to ensure only the proxy can reach this dashboard.
    const clientIp = getClientIp(request);
    if (!isTrustedProxy(clientIp)) {
      return new NextResponse('Forbidden: untrusted proxy', { status: 403 });
    }

    // Validate identity headers. parseAuthHeaders enforces the presence of
    // a non-empty Auth-Sub.
    const user = parseAuthHeaders(request.headers);
    if (user === null) {
      return new NextResponse(
        'Authentication required. This dashboard is configured to authenticate via an upstream proxy.',
        {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }
      );
    }

    return NextResponse.next();
  }

  // OIDC mode (existing behavior).
  const sessionCookie = request.cookies.get('crowdsieve-session');
  if (!sessionCookie) {
    // Redirect to login with the original path for post-login redirect
    const loginUrl = new URL('/login', request.url);
    const pathname = request.nextUrl.pathname;
    // SECURITY: Validate pathname before adding to redirect parameter
    if (isSafeRedirect(pathname) && pathname !== '/') {
      loginUrl.searchParams.set('redirect', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Session cookie exists - allow the request
  // Full session validation happens in the page/API routes
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
