import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LRUCache } from '../src/validation/memory-cache.js';
import type { CacheEntry, ValidationConfig } from '../src/validation/types.js';
import { ClientValidator } from '../src/validation/index.js';

// In-memory stand-in for the persistent (SQLite/PostgreSQL) validation cache.
const persistentCache = vi.hoisted(() => ({
  entries: new Map<string, { tokenHash: string; expiresAt: Date }>(),
  store: [] as Array<{ tokenHash: string; ttlSeconds: number }>,
}));

vi.mock('../src/validation/cache.js', () => ({
  ValidationCache: class {
    async lookup(tokenHash: string) {
      return persistentCache.entries.get(tokenHash) ?? null;
    }
    async store(tokenHash: string, ttlSeconds: number) {
      persistentCache.store.push({ tokenHash, ttlSeconds });
      persistentCache.entries.set(tokenHash, {
        tokenHash,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      });
    }
    async cleanupExpired() {
      return 0;
    }
  },
}));

describe('LRUCache', () => {
  let cache: LRUCache;

  beforeEach(() => {
    cache = new LRUCache(3);
  });

  describe('basic operations', () => {
    it('should store and retrieve entries', () => {
      const entry: CacheEntry = {
        tokenHash: 'hash1',
        expiresAt: new Date(Date.now() + 60000),
      };

      cache.set('key1', entry);
      const result = cache.get('key1');

      expect(result).toEqual(entry);
    });

    it('should return undefined for non-existent keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should delete entries', () => {
      const entry: CacheEntry = {
        tokenHash: 'hash1',
        expiresAt: new Date(Date.now() + 60000),
      };

      cache.set('key1', entry);
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false when deleting non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      cache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should report correct size', () => {
      expect(cache.size()).toBe(0);

      cache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      expect(cache.size()).toBe(1);

      cache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });
      expect(cache.size()).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when at capacity', () => {
      cache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      cache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });
      cache.set('key3', { tokenHash: 'h3', expiresAt: new Date() });

      // Cache is now full (maxSize=3)
      expect(cache.size()).toBe(3);

      // Add new entry, should evict key1 (oldest)
      cache.set('key4', { tokenHash: 'h4', expiresAt: new Date() });

      expect(cache.size()).toBe(3);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeDefined();
      expect(cache.get('key3')).toBeDefined();
      expect(cache.get('key4')).toBeDefined();
    });

    it('should move accessed entry to end (most recently used)', () => {
      cache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      cache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });
      cache.set('key3', { tokenHash: 'h3', expiresAt: new Date() });

      // Access key1, making it most recently used
      cache.get('key1');

      // Add new entry, should evict key2 (now oldest)
      cache.set('key4', { tokenHash: 'h4', expiresAt: new Date() });

      expect(cache.get('key1')).toBeDefined();
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBeDefined();
      expect(cache.get('key4')).toBeDefined();
    });

    it('should not evict when updating existing key', () => {
      cache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      cache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });
      cache.set('key3', { tokenHash: 'h3', expiresAt: new Date() });

      // Update key1 with new value
      const newEntry: CacheEntry = { tokenHash: 'h1-updated', expiresAt: new Date() };
      cache.set('key1', newEntry);

      expect(cache.size()).toBe(3);
      expect(cache.get('key1')).toEqual(newEntry);
      expect(cache.get('key2')).toBeDefined();
      expect(cache.get('key3')).toBeDefined();
    });

    it('should work correctly with maxSize of 1', () => {
      const smallCache = new LRUCache(1);

      smallCache.set('key1', { tokenHash: 'h1', expiresAt: new Date() });
      expect(smallCache.size()).toBe(1);

      smallCache.set('key2', { tokenHash: 'h2', expiresAt: new Date() });
      expect(smallCache.size()).toBe(1);
      expect(smallCache.get('key1')).toBeUndefined();
      expect(smallCache.get('key2')).toBeDefined();
    });
  });

  describe('expiration cleanup', () => {
    it('should remove expired entries', () => {
      const pastDate = new Date(Date.now() - 1000);
      const futureDate = new Date(Date.now() + 60000);

      cache.set('expired1', { tokenHash: 'h1', expiresAt: pastDate });
      cache.set('valid', { tokenHash: 'h2', expiresAt: futureDate });
      cache.set('expired2', { tokenHash: 'h3', expiresAt: pastDate });

      const deleted = cache.cleanupExpired();

      expect(deleted).toBe(2);
      expect(cache.size()).toBe(1);
      expect(cache.get('expired1')).toBeUndefined();
      expect(cache.get('valid')).toBeDefined();
      expect(cache.get('expired2')).toBeUndefined();
    });

    it('should return 0 when no entries are expired', () => {
      const futureDate = new Date(Date.now() + 60000);

      cache.set('key1', { tokenHash: 'h1', expiresAt: futureDate });
      cache.set('key2', { tokenHash: 'h2', expiresAt: futureDate });

      const deleted = cache.cleanupExpired();

      expect(deleted).toBe(0);
      expect(cache.size()).toBe(2);
    });

    it('should handle empty cache', () => {
      const deleted = cache.cleanupExpired();
      expect(deleted).toBe(0);
    });
  });
});

describe('ClientValidator', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const fetchMock = vi.fn();

  function makeValidator(overrides: Partial<ValidationConfig> = {}): ClientValidator {
    return new ClientValidator(
      {
        enabled: true,
        cacheTtlSeconds: 3600,
        cacheTtlErrorSeconds: 300,
        validationTimeoutMs: 5000,
        maxMemoryEntries: 100,
        failClosed: false,
        ...overrides,
      },
      'https://capi.example.test',
      mockLogger as never
    );
  }

  function capiAnswers(status: number): void {
    fetchMock.mockResolvedValue(new Response(status === 204 ? null : '{}', { status }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    persistentCache.entries.clear();
    persistentCache.store.length = 0;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reject requests without authorization header', async () => {
    const result = await makeValidator().validate(undefined);

    expect(result).toEqual({ valid: false, reason: 'no_auth_header', authenticated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authenticates on a CAPI 2xx and caches the result persistently', async () => {
    capiAnswers(200);
    const validator = makeValidator();

    const first = await validator.validate('Bearer good');
    expect(first).toEqual({ valid: true, reason: 'validated', authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://capi.example.test/v3/signals',
      expect.objectContaining({ method: 'POST', body: '[]' })
    );
    expect(persistentCache.store).toEqual([{ tokenHash: expect.any(String), ttlSeconds: 3600 }]);

    const second = await validator.validate('Bearer good');
    expect(second).toEqual({ valid: true, reason: 'cached_memory', authenticated: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('authenticates from the persistent cache', async () => {
    capiAnswers(200);
    await makeValidator().validate('Bearer good');

    // A fresh validator has an empty memory cache.
    const result = await makeValidator().validate('Bearer good');
    expect(result).toEqual({ valid: true, reason: 'cached_sqlite', authenticated: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('rejects invalid credentials (CAPI %i)', async (status) => {
    capiAnswers(status);
    const result = await makeValidator().validate('Bearer bad');

    expect(result).toEqual({ valid: false, reason: 'invalid_credentials', authenticated: false });
    expect(persistentCache.store).toHaveLength(0);
  });

  it.each([400, 404, 405, 413, 422, 429, 431])(
    'rejects the client on a CAPI %i, even in fail-open mode',
    async (status) => {
      capiAnswers(status);
      const validator = makeValidator({ failClosed: false });

      const result = await validator.validate('Bearer forged');
      expect(result).toEqual({ valid: false, reason: 'capi_rejected', authenticated: false });
      expect(persistentCache.store).toHaveLength(0);

      // Nothing was cached: the next request asks CAPI again.
      await validator.validate('Bearer forged');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([500, 502, 503, 504])(
    'fails open on a CAPI %i without authenticating the client',
    async (status) => {
      capiAnswers(status);
      const validator = makeValidator({ failClosed: false });

      const result = await validator.validate('Bearer unknown');
      expect(result).toEqual({ valid: true, reason: 'capi_error_failopen', authenticated: false });
      // Never persisted as a validated client.
      expect(persistentCache.store).toHaveLength(0);

      // Remembered in memory for cacheTtlErrorSeconds, still unauthenticated.
      const cached = await validator.validate('Bearer unknown');
      expect(cached).toEqual({ valid: true, reason: 'cached_failopen', authenticated: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('fails open on a timeout or network error without authenticating the client', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await makeValidator({ failClosed: false }).validate('Bearer unknown');

    expect(result).toEqual({ valid: true, reason: 'capi_error_failopen', authenticated: false });
    expect(persistentCache.store).toHaveLength(0);
  });

  it('expires fail-open entries after cacheTtlErrorSeconds and asks CAPI again', async () => {
    vi.useFakeTimers();
    try {
      capiAnswers(503);
      const validator = makeValidator({ cacheTtlErrorSeconds: 60 });
      await validator.validate('Bearer unknown');

      vi.advanceTimersByTime(61_000);
      capiAnswers(200);
      const result = await validator.validate('Bearer unknown');

      expect(result).toEqual({ valid: true, reason: 'validated', authenticated: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on a CAPI 5xx or network error in fail-closed mode', async () => {
    capiAnswers(503);
    const validator = makeValidator({ failClosed: true });
    expect(await validator.validate('Bearer unknown')).toEqual({
      valid: false,
      reason: 'capi_error_failclosed',
      authenticated: false,
    });

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await validator.validate('Bearer unknown')).toEqual({
      valid: false,
      reason: 'capi_error_failclosed',
      authenticated: false,
    });
    expect(persistentCache.store).toHaveLength(0);
  });

  it('keeps authenticating a cached client during a CAPI outage', async () => {
    capiAnswers(200);
    const validator = makeValidator({ failClosed: true });
    await validator.validate('Bearer good');

    capiAnswers(503);
    expect(await validator.validate('Bearer good')).toEqual({
      valid: true,
      reason: 'cached_memory',
      authenticated: true,
    });
  });
});
