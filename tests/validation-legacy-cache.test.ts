/**
 * Validation cache rows persisted by older versions (which also cached
 * fail-open results) must not be trusted: the migration purges them once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { initializeDatabase, closeDatabase } from '../src/db/index.js';
import { ValidationCache } from '../src/validation/cache.js';
import type { Config } from '../src/config/index.js';

const logger = pino({ level: 'silent' });
let tmpDir: string;

afterEach(async () => {
  await closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(dbPath: string): Config {
  return {
    proxy: { listen_port: 8080, capi_url: 'https://api.crowdsec.net' },
    storage: { type: 'sqlite', path: dbPath, retention_days: 30 },
    lapi_servers: [],
  } as unknown as Config;
}

describe('legacy validated_clients rows', () => {
  it('are purged once, while rows written afterwards are kept', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsieve-legacy-vc-'));
    const dbPath = path.join(tmpDir, 'test.db');

    // Database as left by an older version: old table layout, unexpired row.
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE validated_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        machine_id TEXT,
        validated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 1
      );
    `);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const now = new Date().toISOString();
    old
      .prepare(
        'INSERT INTO validated_clients (token_hash, validated_at, expires_at, last_accessed_at) VALUES (?, ?, ?, ?)'
      )
      .run('legacy-hash', now, future, now);
    old.close();

    await initializeDatabase(config(dbPath), logger);
    const cache = new ValidationCache();
    expect(await cache.lookup('legacy-hash')).toBeNull();

    await cache.store('fresh-hash', 3600);
    await closeDatabase();

    // A later start must not purge again.
    await initializeDatabase(config(dbPath), logger);
    expect(await new ValidationCache().lookup('fresh-hash')).not.toBeNull();
  });
});
