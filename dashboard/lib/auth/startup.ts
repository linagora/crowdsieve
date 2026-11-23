/**
 * Startup checks of the dashboard authentication configuration.
 *
 * Called once per server process by `instrumentation.ts` (Node.js runtime),
 * before the first request is served, so that misconfigurations show up in
 * the logs at startup rather than on the first sign-in attempt.
 */

import { getAuthMode } from './mode';
import { getSessionSecret } from '../oidc/config';
import { getAuthProxySecret, getTrustedProxyIps } from './trust';

/** Recommended minimum length of AUTH_PROXY_SECRET. */
const MIN_PROXY_SECRET_LENGTH = 32;

export function checkAuthConfiguration(): void {
  const mode = getAuthMode();

  if (mode === 'oidc') {
    try {
      // Logs an error (production) or generates a per-process random secret
      // with a warning (development). Generating it here, before the Edge
      // middleware sandbox is created, lets the middleware see it too.
      getSessionSecret();
    } catch {
      // Already logged by getSessionSecret(); requests fail closed.
    }
  }

  if (mode === 'headers') {
    const proxySecret = getAuthProxySecret();
    if (proxySecret === null) {
      const ipNote =
        getTrustedProxyIps().length > 0
          ? ' TRUSTED_PROXY_IPS does not prevent this: such a client can forge X-Forwarded-For.'
          : '';
      console.warn(
        '[auth] AUTH_MODE=headers without AUTH_PROXY_SECRET: any client that can reach the ' +
          'dashboard without going through the authenticating proxy can sign in as anyone by ' +
          `sending Auth-* headers.${ipNote} Set AUTH_PROXY_SECRET and make the proxy send it in ` +
          'the X-Auth-Proxy-Secret header, or make sure that only the proxy can reach the dashboard.'
      );
    } else if (proxySecret.length < MIN_PROXY_SECRET_LENGTH) {
      console.warn(
        `[auth] AUTH_PROXY_SECRET is shorter than ${MIN_PROXY_SECRET_LENGTH} characters; ` +
          'use a random value (openssl rand -hex 32).'
      );
    }
  }
}
