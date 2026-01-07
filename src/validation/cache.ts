import { eq, lt, sql } from 'drizzle-orm';
import { getDatabase, schema } from '../db/index.js';
import type { CacheEntry } from './types.js';

export class ValidationCache {
  async lookup(tokenHash: string): Promise<CacheEntry | null> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.validatedClients)
      .where(eq(schema.validatedClients.tokenHash, tokenHash))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const row = result[0];

    // Update last accessed time and access count
    await db
      .update(schema.validatedClients)
      .set({
        lastAccessedAt: new Date().toISOString(),
        accessCount: (row.accessCount || 0) + 1,
      })
      .where(eq(schema.validatedClients.tokenHash, tokenHash));

    return {
      tokenHash: row.tokenHash,
      expiresAt: new Date(row.expiresAt),
      machineId: row.machineId || undefined,
    };
  }

  async store(tokenHash: string, ttlSeconds: number, machineId?: string): Promise<void> {
    const db = getDatabase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    await db
      .insert(schema.validatedClients)
      .values({
        tokenHash,
        machineId: machineId || null,
        validatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastAccessedAt: now.toISOString(),
        accessCount: 1,
      })
      .onConflictDoUpdate({
        target: schema.validatedClients.tokenHash,
        set: {
          validatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          lastAccessedAt: now.toISOString(),
          accessCount: sql`${schema.validatedClients.accessCount} + 1`,
        },
      });
  }

  async cleanupExpired(): Promise<number> {
    const db = getDatabase();
    const now = new Date().toISOString();

    const result = await db
      .delete(schema.validatedClients)
      .where(lt(schema.validatedClients.expiresAt, now));

    return result.changes;
  }
}
