import { eq, lt, sql } from 'drizzle-orm';
import { getDatabaseContext } from '../db/index.js';
import type { CacheEntry } from './types.js';

export class ValidationCache {
  async lookup(tokenHash: string): Promise<CacheEntry | null> {
    const { db, schema, isPostgres } = getDatabaseContext();

    // Update last accessed time and access count atomically
    const updateQuery = db
      .update(schema.validatedClients)
      .set({
        lastAccessedAt: new Date().toISOString(),
        accessCount: sql`${schema.validatedClients.accessCount} + 1`,
      })
      .where(eq(schema.validatedClients.tokenHash, tokenHash));

    if (isPostgres) {
      await updateQuery;
    } else {
      (updateQuery as unknown as { run(): void }).run();
    }

    // Then fetch the row
    const selectQuery = db
      .select()
      .from(schema.validatedClients)
      .where(eq(schema.validatedClients.tokenHash, tokenHash))
      .limit(1);

    let result: Array<typeof schema.validatedClients.$inferSelect>;
    if (isPostgres) {
      result = await selectQuery;
    } else {
      result = (
        selectQuery as unknown as { all(): Array<typeof schema.validatedClients.$inferSelect> }
      ).all();
    }

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      tokenHash: row.tokenHash,
      expiresAt: new Date(row.expiresAt),
      machineId: row.machineId || undefined,
    };
  }

  async store(tokenHash: string, ttlSeconds: number, machineId?: string): Promise<void> {
    const { db, schema, isPostgres } = getDatabaseContext();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const insertQuery = db
      .insert(schema.validatedClients)
      .values({
        tokenHash,
        machineId: machineId || null,
        validatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastAccessedAt: now.toISOString(),
        accessCount: 1,
      } as typeof schema.validatedClients.$inferInsert)
      .onConflictDoUpdate({
        target: schema.validatedClients.tokenHash,
        set: {
          validatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          lastAccessedAt: now.toISOString(),
          accessCount: sql`${schema.validatedClients.accessCount} + 1`,
        },
      });

    if (isPostgres) {
      await insertQuery;
    } else {
      (insertQuery as unknown as { run(): void }).run();
    }
  }

  async cleanupExpired(): Promise<number> {
    const { db, schema, isPostgres } = getDatabaseContext();
    const now = new Date().toISOString();

    const deleteQuery = db
      .delete(schema.validatedClients)
      .where(lt(schema.validatedClients.expiresAt, now));

    if (isPostgres) {
      const result = await deleteQuery;
      return (result as unknown as { rowCount: number }).rowCount || 0;
    } else {
      const result = (deleteQuery as unknown as { run(): { changes: number } }).run();
      return result.changes;
    }
  }
}
