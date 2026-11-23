/**
 * Startup checks of the dashboard authentication configuration.
 *
 * Called once per server process by `instrumentation.ts` (Node.js runtime),
 * before the first request is served, so that misconfigurations show up in
 * the logs at startup rather than on the first sign-in attempt.
 */

import { getAuthMode } from './mode';
import { getSessionSecret } from '../oidc/config';

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
}
