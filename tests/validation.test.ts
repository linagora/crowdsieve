import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LRUCache } from '../src/validation/memory-cache.js';
import type { CacheEntry } from '../src/validation/types.js';

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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Note: Full ClientValidator tests would require database setup
  // These tests focus on the validation logic with mocked dependencies

  describe('validation logic', () => {
    it('should reject requests without authorization header', async () => {
      // Import dynamically to avoid database initialization issues
      const { ClientValidator } = await import('../src/validation/index.js');

      // Mock the database module
      vi.mock('../src/db/index.js', () => ({
        getDatabase: () => ({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => Promise.resolve(),
            }),
          }),
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: () => Promise.resolve(),
            }),
          }),
        }),
        schema: {
          validatedClients: {},
        },
      }));

      const validator = new ClientValidator(
        {
          enabled: true,
          cacheTtlSeconds: 3600,
          cacheTtlErrorSeconds: 300,
          validationTimeoutMs: 5000,
          maxMemoryEntries: 100,
        },
        'https://api.crowdsec.net',
        mockLogger as any
      );

      const result = await validator.validate(undefined);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('no_auth_header');
    });
  });
});
