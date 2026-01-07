import type { CacheEntry } from './types.js';

export class LRUCache {
  private cache: Map<string, CacheEntry>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // If key exists, just update it (delete + re-add to move to end)
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.cache.set(key, entry);
      return;
    }

    // New key: evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, entry);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  cleanupExpired(): number {
    const now = new Date();
    let deleted = 0;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
