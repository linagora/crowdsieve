/**
 * Cross-site request forgery defence for the dashboard API.
 *
 * Route handlers are not covered by Next.js' Server Actions origin check,
 * and `Request.json()` parses a body whatever its Content-Type, so a
 * cross-site `<form enctype="text/plain">` could post a JSON-looking body.
 * Two layers protect the state-changing routes:
 *
 *   1. The middleware calls `isCrossOriginWrite()` and answers 403 to a
 *      POST/PUT/PATCH/DELETE on /api/* when the browser says it comes from
 *      another origin (`Sec-Fetch-Site`, or an `Origin` that does not match
 *      the dashboard). This applies in every auth mode, including 'none'
 *      (a dashboard bound to 127.0.0.1 can still be reached by a page open
 *      in the operator's browser).
 *   2. JSON write routes require `Content-Type: application/json`
 *      (`requireJsonContentType()` in lib/auth/guard.ts), which an HTML form
 *      cannot send and which triggers a CORS preflight for cross-origin
 *      fetch() calls.
 *
 * Requests without `Sec-Fetch-Site` and `Origin` (curl, server-to-server
 * clients) are not browser CSRF and are let through to the auth checks.
 *
 * This module must remain Edge-Runtime-compatible.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Write endpoints that legitimately receive cross-origin requests:
 * back-channel logout is a server-to-server POST from the OIDC provider,
 * authenticated by its signed logout token.
 */
const CSRF_EXEMPT_PATHS = ['/api/auth/backchannel-logout'];

interface RequestLike {
  method: string;
  headers: Headers;
  nextUrl: { pathname: string; host: string };
}

/** Lowercase a host[:port] and drop the default HTTP(S) port. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/:(80|443)$/, '');
}

/**
 * Hosts under which the dashboard is reached: the request's own Host (also
 * as seen through Next.js' URL), the first X-Forwarded-Host entry set by a
 * reverse proxy that rewrites Host, and the configured public URL
 * (NEXTAUTH_URL). A cross-site page cannot set X-Forwarded-Host: a form
 * cannot send custom headers and fetch() would need a CORS preflight.
 *
 * The scheme is not compared: browsers that send Origin also send
 * Sec-Fetch-Site, which already flags a scheme mismatch as cross-site.
 */
function getAllowedHosts(request: RequestLike): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value && value.trim().length > 0) hosts.add(normalizeHost(value));
  };

  add(request.nextUrl.host);
  add(request.headers.get('host'));
  add(request.headers.get('x-forwarded-host')?.split(',')[0]);

  const baseUrl = process.env.NEXTAUTH_URL?.trim();
  if (baseUrl) {
    try {
      add(new URL(baseUrl).host);
    } catch {
      // Invalid NEXTAUTH_URL: ignore it here.
    }
  }
  return hosts;
}

function isOriginAllowed(origin: string, request: RequestLike): boolean {
  // "null" is sent by sandboxed iframes, data: URLs and some redirects.
  if (origin === 'null') return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return getAllowedHosts(request).has(normalizeHost(host));
}

/**
 * Whether the request is a state-changing call to the dashboard API that a
 * browser flags as coming from another origin. The middleware answers 403
 * to such requests.
 */
export function isCrossOriginWrite(request: RequestLike): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;

  const { pathname } = request.nextUrl;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
  if (CSRF_EXEMPT_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'))) {
    return false;
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== 'same-origin') {
    return true;
  }

  const origin = request.headers.get('origin');
  if (origin !== null && !isOriginAllowed(origin.trim(), request)) {
    return true;
  }

  return false;
}
