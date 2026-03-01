import { createRequire } from 'module';
import type { LapiServer } from '../config/index.js';

// Package version for User-Agent header (sourced from package.json)
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };
export const CROWDSIEVE_VERSION = version;

// JWT token cache for machine authentication
interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

// Cleanup expired tokens periodically (every 5 minutes)
const TOKEN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(key);
    }
  }
}

// Start cleanup interval (unref to not block process exit)
const cleanupInterval = setInterval(cleanupExpiredTokens, TOKEN_CLEANUP_INTERVAL_MS);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

export interface MachineTokenLogger {
  error: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

/**
 * Get or refresh JWT token for a LAPI server using machine credentials
 */
export async function getMachineToken(
  server: LapiServer,
  timeoutMs: number,
  logger: MachineTokenLogger
): Promise<string | null> {
  if (!server.machine_id || !server.password) {
    return null;
  }

  const cacheKey = `${server.name}:${server.machine_id}`;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid (with 10s margin)
  if (cached && cached.expiresAt > Date.now() + 10000) {
    return cached.token;
  }

  try {
    const response = await fetch(`${server.url}/v1/watchers/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
      },
      body: JSON.stringify({
        machine_id: server.machine_id,
        password: server.password,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { server: server.name, status: response.status, error: errorBody },
        'Failed to get machine token from LAPI'
      );
      return null;
    }

    const data = (await response.json()) as { token: string; expire: string };
    const expiresAt = new Date(data.expire).getTime();

    tokenCache.set(cacheKey, { token: data.token, expiresAt });
    logger.debug({ server: server.name }, 'Got new machine token from LAPI');

    return data.token;
  } catch (err) {
    logger.error({ server: server.name, err }, 'Error getting machine token');
    return null;
  }
}

/**
 * Clear the token cache (useful for testing)
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}
