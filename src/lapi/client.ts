/**
 * Shared LAPI HTTP client utilities.
 *
 * Re-exports the JWT machine-token cache from `auth/machineToken.ts` (kept as
 * the historical home of `getMachineToken` for back-compat with existing
 * callers in `replication/`, `proxy/routes/api.ts`, etc.) and adds a small
 * `lapiFetch` helper that wraps `fetch` with the project-standard User-Agent
 * and a per-request timeout. New code talking to LAPI (e.g. the bouncer
 * usage-metrics collector) goes through this module.
 */

import type { LapiServer } from '../config/index.js';
import { CROWDSIEVE_VERSION, getMachineToken } from '../auth/machineToken.js';

export { CROWDSIEVE_VERSION, getMachineToken };
export type { MachineTokenLogger } from '../auth/machineToken.js';

export interface LapiFetchLogger {
  error: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

/**
 * Fetch a path on a LAPI server. Sets the project User-Agent header and a
 * request timeout. Caller-supplied headers in `init.headers` win over defaults
 * (e.g. to override the Authorization or X-Api-Key header).
 *
 * Returns the raw `Response` so callers can decide how to parse the body and
 * how to surface non-2xx codes.
 */
export async function lapiFetch(
  server: LapiServer,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  _logger: LapiFetchLogger
): Promise<Response> {
  const url = `${server.url}${path}`;
  const headers: Record<string, string> = {
    'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
  };

  // Merge caller-supplied headers (caller wins for duplicates).
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers as Record<string, string>);
    }
  }

  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
