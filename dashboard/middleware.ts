import { NextRequest, NextResponse } from 'next/server';

/**
 * SECURITY: Middleware for OIDC authentication gate
 *
 * This middleware runs in Edge Runtime and performs lightweight session checks.
 * Full session validation (expiration, revocation) happens in page/API routes
 * because Edge Runtime has limited crypto capabilities.
 *
 * Security considerations:
 * - Only checks cookie presence, not validity (defense in depth with route checks)
 * - Public paths are explicitly allowlisted to prevent auth bypass
 * - Redirect parameter uses pathname only (validated in login page to prevent open redirect)
 */

// Public paths that don't require authentication
// SECURITY: Be careful adding paths - they bypass authentication
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/auth/session',
  '/api/auth/backchannel-logout',
  '/_next',
  '/favicon.ico',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'));
}

// Check if OIDC is enabled by looking at environment variables
// Note: We can't use the config module here because middleware runs in Edge Runtime
function isOidcEnabled(): boolean {
  return !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // If OIDC is not configured, allow all requests (current behavior)
  if (!isOidcEnabled()) {
    return NextResponse.next();
  }

  // Allow public paths
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionCookie = request.cookies.get('crowdsieve-session');
  if (!sessionCookie) {
    // Redirect to login
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
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
