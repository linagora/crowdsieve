/**
 * PostgreSQL database initialization and migrations.
 *
 * This module handles:
 * - Dynamic import of 'pg' (optional dependency)
 * - Connection pool setup
 * - Auto-creation of tables if user has CREATE permissions
 * - Graceful error handling with helpful messages
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import type { PostgresConfig } from '../config/index.js';
import * as schema from './schema.postgres.js';
import type { Logger } from 'pino';

// Re-export PostgreSQL schema
export { schema };

export type PostgresDb = ReturnType<typeof drizzle<typeof schema>>;

// Pool type from pg (we import dynamically)
type PgPool = import('pg').Pool;

let pool: PgPool | null = null;
let db: PostgresDb | null = null;

/**
 * PostgreSQL error codes
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_ERROR_CODES = {
  INSUFFICIENT_PRIVILEGE: '42501',
  UNDEFINED_TABLE: '42P01',
  DUPLICATE_TABLE: '42P07',
};

function isPermissionError(err: unknown): boolean {
  return (err as { code?: string })?.code === PG_ERROR_CODES.INSUFFICIENT_PRIVILEGE;
}

/**
 * SQL DDL for creating PostgreSQL tables.
 * Uses CREATE TABLE IF NOT EXISTS for idempotent setup.
 */
const POSTGRES_MIGRATIONS = `
  -- Alerts table
  CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
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
    simulated BOOLEAN DEFAULT FALSE,
    remediation BOOLEAN DEFAULT FALSE,
    has_decisions BOOLEAN DEFAULT FALSE,
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
    geo_latitude DOUBLE PRECISION,
    geo_longitude DOUBLE PRECISION,
    geo_timezone TEXT,
    geo_isp TEXT,
    geo_org TEXT,
    filtered BOOLEAN DEFAULT FALSE,
    filter_reasons TEXT,
    forwarded_to_capi BOOLEAN DEFAULT FALSE,
    forwarded_at TEXT,
    raw_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scenario ON alerts(scenario);
  CREATE INDEX IF NOT EXISTS idx_source_ip ON alerts(source_ip);
  CREATE INDEX IF NOT EXISTS idx_received_at ON alerts(received_at);
  CREATE INDEX IF NOT EXISTS idx_country_code ON alerts(geo_country_code);
  CREATE INDEX IF NOT EXISTS idx_filtered ON alerts(filtered);
  CREATE INDEX IF NOT EXISTS idx_machine_id ON alerts(machine_id);

  -- Decisions table
  CREATE TABLE IF NOT EXISTS decisions (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
    uuid TEXT,
    origin TEXT,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    value TEXT NOT NULL,
    duration TEXT,
    scenario TEXT,
    simulated BOOLEAN DEFAULT FALSE,
    until TEXT,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_decision_alert ON decisions(alert_id);
  CREATE INDEX IF NOT EXISTS idx_decision_value ON decisions(value);
  CREATE INDEX IF NOT EXISTS idx_decision_type ON decisions(type);

  -- Events table
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
    timestamp TEXT,
    meta TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_event_alert ON events(alert_id);

  -- Validated clients table
  CREATE TABLE IF NOT EXISTS validated_clients (
    id SERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    machine_id TEXT,
    validated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    access_count INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_vc_expires_at ON validated_clients(expires_at);
`;

/**
 * Initialize PostgreSQL database connection and run migrations.
 *
 * @param config - PostgreSQL connection configuration
 * @param logger - Logger instance for output
 * @returns Drizzle database instance
 * @throws Error if pg module not installed or insufficient permissions
 */
export async function initializePostgres(
  config: PostgresConfig,
  logger: Logger
): Promise<PostgresDb> {
  // Dynamically import pg (optional dependency)
  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      'PostgreSQL support requires the "pg" package.\n' +
        'Install it with: npm install pg\n' +
        'Or use SQLite (default) by setting DATABASE_TYPE=sqlite'
    );
  }

  // Create connection pool
  pool = new pg.default.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: config.ssl_reject_unauthorized ?? true } : false,
    max: config.pool_size,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection
  try {
    const client = await pool.connect();
    client.release();
    logger.debug('PostgreSQL connection test successful');
  } catch (err) {
    const error = err as Error;
    throw new Error(`Failed to connect to PostgreSQL: ${error.message}`);
  }

  // Run migrations (create tables if not exist)
  try {
    await pool.query(POSTGRES_MIGRATIONS);
    logger.info('PostgreSQL tables initialized successfully');
  } catch (err) {
    if (isPermissionError(err)) {
      logger.error(
        'PostgreSQL permission denied. The database user does not have CREATE TABLE rights.\n' +
          'Either grant CREATE permissions to the user, or create tables manually.\n' +
          'See: https://github.com/linagora/crowdsieve/blob/master/docs/postgresql-setup.md'
      );
      throw new Error('PostgreSQL initialization failed: insufficient permissions');
    }
    throw err;
  }

  // Create Drizzle instance
  db = drizzle(pool, { schema });

  return db;
}

/**
 * Get the PostgreSQL database instance.
 * @throws Error if not initialized
 */
export function getPostgresDatabase(): PostgresDb {
  if (!db) {
    throw new Error('PostgreSQL database not initialized');
  }
  return db;
}

/**
 * Close the PostgreSQL connection pool.
 */
export async function closePostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
