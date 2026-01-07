import { createHash } from 'crypto';
import type { Logger } from 'pino';
import { LRUCache } from './memory-cache.js';
import { ValidationCache } from './cache.js';
import type { ValidationConfig, ValidationResult, CacheEntry } from './types.js';

export { ValidationConfig, ValidationResult } from './types.js';

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
  private logger: Logger;

  constructor(config: ValidationConfig, capiUrl: string, logger: Logger) {
    this.config = config;
    this.capiUrl = capiUrl;
    this.logger = logger;
    this.memoryCache = new LRUCache(config.maxMemoryEntries);
    this.dbCache = new ValidationCache();
  }

  async validate(authHeader: string | undefined): Promise<ValidationResult> {
    // 1. No header = reject
    if (!authHeader) {
      return { valid: false, reason: 'no_auth_header' };
    }

    const tokenHash = sha256(authHeader);
    const shortHash = tokenHash.substring(0, 8);

    // 2. Check memory cache
    const memEntry = this.memoryCache.get(tokenHash);
    if (memEntry && !isExpired(memEntry)) {
      this.logger.debug({ tokenHash: shortHash }, 'Client validated from memory cache');
      return { valid: true, reason: 'cached_memory' };
    }

    // 3. Check SQLite cache
    try {
      const dbEntry = await this.dbCache.lookup(tokenHash);
      if (dbEntry && !isExpired(dbEntry)) {
        // Promote to memory cache
        this.memoryCache.set(tokenHash, dbEntry);
        this.logger.debug({ tokenHash: shortHash }, 'Client validated from SQLite cache');
        return { valid: true, reason: 'cached_sqlite' };
      }
    } catch (err) {
      this.logger.error({ err, tokenHash: shortHash }, 'Failed to check SQLite cache');
      // Continue to CAPI validation
    }

    // 4. Validate with CAPI using HEAD request (lightweight, no body transfer)
    try {
      const response = await fetch(`${this.capiUrl}/v2/decisions/stream?startup=true`, {
        method: 'HEAD',
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(this.config.validationTimeoutMs),
      });

      if (response.ok) {
        await this.cacheClient(tokenHash, this.config.cacheTtlSeconds);
        this.logger.info({ tokenHash: shortHash }, 'Client validated with CAPI');
        return { valid: true, reason: 'validated' };
      }

      // 401/403 = invalid credentials
      if (response.status === 401 || response.status === 403) {
        this.logger.warn({ status: response.status }, 'Client rejected - invalid credentials');
        return { valid: false, reason: 'invalid_credentials' };
      }

      // Other CAPI error (5xx, 429, etc.)
      if (this.config.failClosed) {
        this.logger.error(
          { tokenHash: shortHash, status: response.status },
          'CAPI returned error, rejecting request (fail-closed mode)'
        );
        return { valid: false, reason: 'capi_error_failclosed' };
      }

      this.logger.warn(
        { tokenHash: shortHash, status: response.status },
        'CAPI returned error, allowing request (fail-open)'
      );
      await this.cacheClient(tokenHash, this.config.cacheTtlErrorSeconds);
      return { valid: true, reason: 'capi_error_failopen' };
    } catch (err) {
      // Timeout/network error
      if (this.config.failClosed) {
        this.logger.error({ err, tokenHash: shortHash }, 'CAPI validation failed, rejecting request (fail-closed mode)');
        return { valid: false, reason: 'capi_error_failclosed' };
      }

      this.logger.warn({ err, tokenHash: shortHash }, 'CAPI validation failed, allowing request (fail-open)');
      await this.cacheClient(tokenHash, this.config.cacheTtlErrorSeconds);
      return { valid: true, reason: 'capi_error_failopen' };
    }
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
