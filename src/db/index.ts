import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import fs from 'fs';
import path from 'path';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;

export function initializeDatabase(dbPath: string) {
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
  } catch {
    // Ignore permission errors (may happen on Windows)
  }

  // Create Drizzle instance
  db = drizzle(sqlite, { schema });

  // Run inline migrations (create tables if not exist)
  runMigrations(sqlite);

  return db;
}

function runMigrations(sqlite: Database.Database) {
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
  `);
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function closeDatabase() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

export { schema };
