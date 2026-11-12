import { isSafeRedirect } from './validation';

/**
 * Build the `/api/auth/login` link, forwarding a validated post-login path.
 *
 * SECURITY: `isSafeRedirect` only accepts local paths; anything else is
 * dropped and the user lands on the home page after signing in.
 */
export function buildLoginHref(redirect: string | undefined): string {
  return isSafeRedirect(redirect)
    ? `/api/auth/login?redirect=${encodeURIComponent(redirect)}`
    : '/api/auth/login';
}

/**
 * Resolve the path to send a freshly signed-in user to. Used by the login page
 * (already signed in) and by the OIDC callback (path stored in the session).
 */
export function resolvePostLoginPath(redirect: string | undefined): string {
  return isSafeRedirect(redirect) ? redirect : '/';
}
