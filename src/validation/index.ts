import { createHash } from 'crypto';
import type { BaseLogger } from 'pino';
import { LRUCache } from './memory-cache.js';
import { ValidationCache } from './cache.js';
import type { ValidationConfig, ValidationResult, CacheEntry } from './types.js';

export type { ValidationConfig, ValidationResult } from './types.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isExpired(entry: CacheEntry): boolean {
  return entry.expiresAt <= new Date();
}

export class ClientValidator {
  private memoryCache: LRUCache;
  private dbCache: ValidationCache;
  private config: ValidationConfig;
  private capiUrl: string;
  private logger: BaseLogger;

  constructor(config: ValidationConfig, capiUrl: string, logger: BaseLogger) {
    this.config = config;
    this.capiUrl = capiUrl;
    this.logger = logger;
    this.memoryCache = new LRUCache(config.maxMemoryEntries);
    this.dbCache = new ValidationCache();
  }

  async validate(authHeader: string | undefined): Promise<ValidationResult> {
    // 1. No header = reject
    if (!authHeader) {
      return { valid: false, reason: 'no_auth_header', authenticated: false };
    }

    const tokenHash = sha256(authHeader);
    const shortHash = tokenHash.substring(0, 8);

    // 2. Check memory cache
    const memEntry = this.memoryCache.get(tokenHash);
    if (memEntry && !isExpired(memEntry)) {
      if (memEntry.failOpen) {
        // A recent fail-open: keep letting the client through without
        // hammering an unavailable CAPI, but never as an authenticated client.
        this.logger.debug({ tokenHash: shortHash }, 'Client allowed from fail-open cache');
        return { valid: true, reason: 'cached_failopen', authenticated: false };
      }
      this.logger.debug({ tokenHash: shortHash }, 'Client validated from memory cache');
      return { valid: true, reason: 'cached_memory', authenticated: true };
    }

    // 3. Check SQLite cache (only real CAPI validations are persisted)
    try {
      const dbEntry = await this.dbCache.lookup(tokenHash);
      if (dbEntry && !isExpired(dbEntry)) {
        // Promote to memory cache
        this.memoryCache.set(tokenHash, dbEntry);
        this.logger.debug({ tokenHash: shortHash }, 'Client validated from SQLite cache');
        return { valid: true, reason: 'cached_sqlite', authenticated: true };
      }
    } catch (err) {
      this.logger.error({ err, tokenHash: shortHash }, 'Failed to check SQLite cache');
      // Continue to CAPI validation
    }

    // 4. Validate with CAPI by sending an empty signals array
    // Note: We use /v3/signals with an empty array because:
    // - /v2/decisions/stream is for bouncers (uses API key)
    // - LAPI machines use JWT tokens obtained from /v3/watchers/login
    // - Sending an empty signals array is lightweight and validates the JWT
    let response: Response;
    try {
      response = await fetch(`${this.capiUrl}/v3/signals`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: '[]',
        signal: AbortSignal.timeout(this.config.validationTimeoutMs),
      });
    } catch (err) {
      // Timeout/network error: CAPI is unavailable
      return this.capiUnavailable(tokenHash, { err }, 'CAPI validation failed');
    }

    if (response.ok) {
      await this.cacheClient(tokenHash, this.config.cacheTtlSeconds);
      this.logger.info({ tokenHash: shortHash }, 'Client validated with CAPI');
      return { valid: true, reason: 'validated', authenticated: true };
    }

    // 401/403 = invalid credentials
    if (response.status === 401 || response.status === 403) {
      this.logger.warn({ status: response.status }, 'Client rejected - invalid credentials');
      return { valid: false, reason: 'invalid_credentials', authenticated: false };
    }

    // 5xx = CAPI itself is failing: the only status that may fail open
    if (response.status >= 500) {
      return this.capiUnavailable(
        tokenHash,
        { status: response.status },
        'CAPI returned a server error'
      );
    }

    // Any other non-2xx status (400, 404, 413, 429, ...) means CAPI did not
    // accept this request. A client must never be able to turn a malformed or
    // oversized Authorization header into an accepted one, so this is a
    // rejection whatever `fail_closed` says.
    this.logger.warn(
      { tokenHash: shortHash, status: response.status },
      'Client rejected - CAPI did not accept the credentials'
    );
    return { valid: false, reason: 'capi_rejected', authenticated: false };
  }

  /**
   * Handle a CAPI outage (5xx, timeout, network error).
   *
   * Fail-closed: reject. Fail-open: let the request through without
   * authenticating it, and remember that in the memory cache only, for
   * `cacheTtlErrorSeconds`, so an outage does not cost a CAPI round-trip (and
   * possibly a full timeout) on every request. Fail-open entries are never
   * written to the persistent cache.
   */
  private capiUnavailable(
    tokenHash: string,
    details: Record<string, unknown>,
    message: string
  ): ValidationResult {
    const shortHash = tokenHash.substring(0, 8);
    if (this.config.failClosed) {
      this.logger.error(
        { ...details, tokenHash: shortHash },
        `${message}, rejecting request (fail-closed mode)`
      );
      return { valid: false, reason: 'capi_error_failclosed', authenticated: false };
    }

    this.logger.warn(
      { ...details, tokenHash: shortHash },
      `${message}, allowing request without authentication (fail-open)`
    );
    this.memoryCache.set(tokenHash, {
      tokenHash,
      expiresAt: new Date(Date.now() + this.config.cacheTtlErrorSeconds * 1000),
      failOpen: true,
    });
    return { valid: true, reason: 'capi_error_failopen', authenticated: false };
  }

  private async cacheClient(tokenHash: string, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const entry: CacheEntry = { tokenHash, expiresAt };

    // Add to memory cache
    this.memoryCache.set(tokenHash, entry);

    // Add to SQLite cache
    try {
      await this.dbCache.store(tokenHash, ttlSeconds);
    } catch (err) {
      this.logger.error({ err }, 'Failed to store client in SQLite cache');
    }
  }

  async cleanupExpired(): Promise<{ memory: number; sqlite: number }> {
    const memory = this.memoryCache.cleanupExpired();

    let sqlite = 0;
    try {
      sqlite = await this.dbCache.cleanupExpired();
    } catch (err) {
      this.logger.error({ err }, 'Failed to cleanup SQLite cache');
    }

    if (memory > 0 || sqlite > 0) {
      this.logger.info({ memory, sqlite }, 'Cleaned up expired validation cache entries');
    }

    return { memory, sqlite };
  }
}
