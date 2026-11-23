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
 *   - 'oidc'    : unseal the iron-session cookie and require a signed-in,
 *                 unexpired session; otherwise redirect pages to /login and
 *                 answer 401 to API calls.
 *   - 'headers' : require a valid `Auth-Sub` header from a trusted upstream
 *                 (AUTH_PROXY_SECRET / TRUSTED_PROXY_IPS, see lib/auth/trust.ts).
 *
 * Edge runtime caveat: the back-channel revocation store lives in the
 * Node.js server, so revocation is checked again by `requireAuth()` /
 * `requirePageAuth()` (lib/auth/guard.ts) in every API route and data page.
 */

import { getAuthMode } from '@/lib/auth/mode';
import { checkTrustedUpstream } from '@/lib/auth/trust';
import { parseAuthHeaders } from '@/lib/auth/headers';
import { isLiveSession, SESSION_COOKIE_NAME, unsealSessionCookie } from '@/lib/oidc/session-cookie';

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

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
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
    // The Auth-* headers are only trusted from the authenticating proxy:
    // require AUTH_PROXY_SECRET (X-Auth-Proxy-Secret) and/or a right-most
    // X-Forwarded-For entry in TRUSTED_PROXY_IPS, when configured. With
    // neither, we rely on the network layer to ensure only the proxy can
    // reach this dashboard (a warning is logged at startup).
    if (!checkTrustedUpstream(request.headers).ok) {
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

  // OIDC mode: the cookie must unseal with SESSION_SECRET and hold a
  // signed-in, unexpired session. The cookie saved by the public
  // /api/auth/login (login in progress, no `user`) does not qualify.
  const session = await unsealSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (isLiveSession(session)) {
    return NextResponse.next();
  }

  // API calls get a JSON 401 instead of an HTML login page.
  if (isApiPath(request.nextUrl.pathname)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Redirect to login with the original path and query string, so a shared
  // link such as /decisions?ip=... lands on the requested page after sign-in.
  const loginUrl = new URL('/login', request.url);
  const returnPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  // SECURITY: Validate the return path before adding it to the redirect
  // parameter. The login page and the OIDC callback validate it again.
  if (isSafeRedirect(returnPath) && returnPath !== '/') {
    loginUrl.searchParams.set('redirect', returnPath);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
