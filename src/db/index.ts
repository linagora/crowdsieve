import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteSchema from './schema.js';
import * as postgresSchema from './schema.postgres.js';
import { setAdapter, getAdapter, type DatabaseAdapter, type DatabaseType } from './adapter.js';
import { initializePostgres, closePostgres, type PostgresDb } from './postgres.js';
import type { Config } from '../config/index.js';
import type { Logger } from 'pino';
import fs from 'fs';
import path from 'path';

// Type aliases for the two database types
type SQLiteDb = ReturnType<typeof drizzle<typeof sqliteSchema>>;
type AnyDb = SQLiteDb | PostgresDb;

// Global state
let db: AnyDb | null = null;
let sqlite: Database.Database | null = null;
let currentType: DatabaseType = 'sqlite';

/**
 * SQLite database adapter
 */
class SQLiteAdapter implements DatabaseAdapter {
  readonly type: DatabaseType = 'sqlite';

  async close(): Promise<void> {
    if (sqlite) {
      sqlite.close();
      sqlite = null;
      db = null;
    }
  }
}

/**
 * PostgreSQL database adapter
 */
class PostgresAdapter implements DatabaseAdapter {
  readonly type: DatabaseType = 'postgres';

  async close(): Promise<void> {
    await closePostgres();
    db = null;
  }
}

/**
 * Initialize SQLite database
 */
function initializeSQLite(dbPath: string): SQLiteDb {
  // Ensure data directory exists with restrictive permissions
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  // Initialize SQLite with WAL mode
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  // Set restrictive permissions on database file
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch (err) {
    // On Windows, chmod may not be supported; ignore errors there.
    if (process.platform !== 'win32') {
      console.warn(
        'Warning: failed to set restrictive permissions (0600) on database file:',
        dbPath,
        err
      );
    }
  }

  // Create Drizzle instance
  const sqliteDb = drizzle(sqlite, { schema: sqliteSchema });

  // Run inline migrations (create tables if not exist)
  runSQLiteMigrations(sqlite);

  return sqliteDb;
}

/**
 * SQLite migrations (create tables if not exist)
 */
function runSQLiteMigrations(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT,
      machine_id TEXT,
      scenario TEXT NOT NULL,
      scenario_hash TEXT,
      scenario_version TEXT,
      message TEXT,
      events_count INTEGER,
      capacity INTEGER,
      leakspeed TEXT,
      start_at TEXT,
      stop_at TEXT,
      created_at TEXT,
      received_at TEXT NOT NULL,
      simulated INTEGER DEFAULT 0,
      remediation INTEGER DEFAULT 0,
      has_decisions INTEGER DEFAULT 0,
      source_scope TEXT,
      source_value TEXT,
      source_ip TEXT,
      source_range TEXT,
      source_as_number TEXT,
      source_as_name TEXT,
      source_cn TEXT,
      geo_country_code TEXT,
      geo_country_name TEXT,
      geo_city TEXT,
      geo_region TEXT,
      geo_latitude REAL,
      geo_longitude REAL,
      geo_timezone TEXT,
      geo_isp TEXT,
      geo_org TEXT,
      filtered INTEGER DEFAULT 0,
      filter_reasons TEXT,
      forwarded_to_capi INTEGER DEFAULT 0,
      forwarded_at TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scenario ON alerts(scenario);
    CREATE INDEX IF NOT EXISTS idx_source_ip ON alerts(source_ip);
    CREATE INDEX IF NOT EXISTS idx_received_at ON alerts(received_at);
    CREATE INDEX IF NOT EXISTS idx_country_code ON alerts(geo_country_code);
    CREATE INDEX IF NOT EXISTS idx_filtered ON alerts(filtered);
    CREATE INDEX IF NOT EXISTS idx_machine_id ON alerts(machine_id);

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
      uuid TEXT,
      origin TEXT,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      value TEXT NOT NULL,
      duration TEXT,
      scenario TEXT,
      simulated INTEGER DEFAULT 0,
      until TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decision_alert ON decisions(alert_id);
    CREATE INDEX IF NOT EXISTS idx_decision_value ON decisions(value);
    CREATE INDEX IF NOT EXISTS idx_decision_type ON decisions(type);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
      timestamp TEXT,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_event_alert ON events(alert_id);

    CREATE TABLE IF NOT EXISTS validated_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      machine_id TEXT,
      validated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 1
    );

    -- Note: token_hash already has implicit index from UNIQUE constraint
    CREATE INDEX IF NOT EXISTS idx_vc_expires_at ON validated_clients(expires_at);
  `);
}

/**
 * Initialize database based on configuration.
 *
 * @param config - Full application configuration
 * @param logger - Logger instance
 */
export async function initializeDatabase(config: Config, logger: Logger): Promise<void> {
  const storageType = config.storage.type;
  currentType = storageType;

  if (storageType === 'postgres') {
    if (!config.storage.postgres) {
      throw new Error(
        'PostgreSQL configuration missing. Set POSTGRES_HOST, POSTGRES_DATABASE, etc.'
      );
    }
    db = await initializePostgres(config.storage.postgres, logger);
    setAdapter(new PostgresAdapter());
    logger.info('Database initialized: PostgreSQL');
  } else {
    db = initializeSQLite(config.storage.path);
    setAdapter(new SQLiteAdapter());
    logger.info({ path: config.storage.path }, 'Database initialized: SQLite');
  }
}

/**
 * Get the database instance.
 * Returns the Drizzle database instance for the current backend.
 */
export function getDatabase(): AnyDb {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Get the current database type.
 */
export function getDatabaseType(): DatabaseType {
  return currentType;
}

/**
 * Get the schema for the current database type.
 */
export function getSchema() {
  return currentType === 'postgres' ? postgresSchema : sqliteSchema;
}

/**
 * Close the database connection.
 */
export async function closeDatabase(): Promise<void> {
  try {
    const adapter = getAdapter();
    await adapter.close();
  } catch {
    // Adapter not initialized, nothing to close
  }
}

// Re-export schemas for backward compatibility
export { sqliteSchema as schema };
export { postgresSchema };
export { getAdapter, getDatabaseType as getAdapterType } from './adapter.js';
