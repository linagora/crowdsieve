#!/usr/bin/env node
/**
 * Migration script: SQLite to PostgreSQL
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.js <sqlite-db-path>
 *
 * Environment variables required:
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD
 *
 * Optional:
 *   POSTGRES_SSL (default: false)
 */

import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

// Configuration
const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error('Usage: node scripts/migrate-sqlite-to-postgres.js <sqlite-db-path>');
  process.exit(1);
}

const pgConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DATABASE,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

if (!pgConfig.database || !pgConfig.user) {
  console.error('Error: POSTGRES_DATABASE and POSTGRES_USER environment variables are required');
  process.exit(1);
}

// SQL for creating tables in PostgreSQL
const createTablesSql = `
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
  received_at TEXT NOT NULL DEFAULT NOW(),
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

CREATE INDEX IF NOT EXISTS idx_alerts_scenario ON alerts(scenario);
CREATE INDEX IF NOT EXISTS idx_alerts_source_ip ON alerts(source_ip);
CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts(received_at);
CREATE INDEX IF NOT EXISTS idx_alerts_country_code ON alerts(geo_country_code);
CREATE INDEX IF NOT EXISTS idx_alerts_filtered ON alerts(filtered);
CREATE INDEX IF NOT EXISTS idx_alerts_machine_id ON alerts(machine_id);

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
  created_at TEXT DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decisions_alert ON decisions(alert_id);
CREATE INDEX IF NOT EXISTS idx_decisions_value ON decisions(value);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  timestamp TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_alert ON events(alert_id);

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

async function migrate() {
  console.log(`Migrating from ${sqlitePath} to PostgreSQL at ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`);

  // Open SQLite database
  let sqlite;
  try {
    sqlite = new Database(sqlitePath, { readonly: true });
  } catch (err) {
    console.error(`Error opening SQLite database: ${err.message}`);
    process.exit(1);
  }

  // Connect to PostgreSQL
  const pool = new Pool(pgConfig);
  let client;

  try {
    client = await pool.connect();
    console.log('Connected to PostgreSQL');

    // Create tables
    console.log('Creating tables...');
    await client.query(createTablesSql);

    // Migrate alerts
    console.log('Migrating alerts...');
    const alerts = sqlite.prepare('SELECT * FROM alerts').all();
    console.log(`Found ${alerts.length} alerts`);

    // Map old alert IDs to new IDs
    const alertIdMap = new Map();

    for (const alert of alerts) {
      const result = await client.query(
        `INSERT INTO alerts (
          uuid, machine_id, scenario, scenario_hash, scenario_version,
          message, events_count, capacity, leakspeed, start_at, stop_at,
          created_at, received_at, simulated, remediation, has_decisions,
          source_scope, source_value, source_ip, source_range,
          source_as_number, source_as_name, source_cn,
          geo_country_code, geo_country_name, geo_city, geo_region,
          geo_latitude, geo_longitude, geo_timezone, geo_isp, geo_org,
          filtered, filter_reasons, forwarded_to_capi, forwarded_at, raw_json
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37
        ) RETURNING id`,
        [
          alert.uuid,
          alert.machine_id,
          alert.scenario,
          alert.scenario_hash,
          alert.scenario_version,
          alert.message,
          alert.events_count,
          alert.capacity,
          alert.leakspeed,
          alert.start_at,
          alert.stop_at,
          alert.created_at,
          alert.received_at,
          Boolean(alert.simulated),
          Boolean(alert.remediation),
          Boolean(alert.has_decisions),
          alert.source_scope,
          alert.source_value,
          alert.source_ip,
          alert.source_range,
          alert.source_as_number,
          alert.source_as_name,
          alert.source_cn,
          alert.geo_country_code,
          alert.geo_country_name,
          alert.geo_city,
          alert.geo_region,
          alert.geo_latitude,
          alert.geo_longitude,
          alert.geo_timezone,
          alert.geo_isp,
          alert.geo_org,
          Boolean(alert.filtered),
          alert.filter_reasons,
          Boolean(alert.forwarded_to_capi),
          alert.forwarded_at,
          alert.raw_json,
        ]
      );
      alertIdMap.set(alert.id, result.rows[0].id);
    }
    console.log(`Migrated ${alerts.length} alerts`);

    // Migrate decisions
    console.log('Migrating decisions...');
    const decisions = sqlite.prepare('SELECT * FROM decisions').all();
    console.log(`Found ${decisions.length} decisions`);

    for (const decision of decisions) {
      const newAlertId = alertIdMap.get(decision.alert_id);
      if (!newAlertId) {
        console.warn(`Warning: Decision ${decision.id} references non-existent alert ${decision.alert_id}, skipping`);
        continue;
      }

      await client.query(
        `INSERT INTO decisions (
          alert_id, uuid, origin, type, scope, value, duration, scenario, simulated, until, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          newAlertId,
          decision.uuid,
          decision.origin,
          decision.type,
          decision.scope,
          decision.value,
          decision.duration,
          decision.scenario,
          Boolean(decision.simulated),
          decision.until,
          decision.created_at,
        ]
      );
    }
    console.log(`Migrated ${decisions.length} decisions`);

    // Migrate events
    console.log('Migrating events...');
    const events = sqlite.prepare('SELECT * FROM events').all();
    console.log(`Found ${events.length} events`);

    for (const event of events) {
      const newAlertId = alertIdMap.get(event.alert_id);
      if (!newAlertId) {
        console.warn(`Warning: Event ${event.id} references non-existent alert ${event.alert_id}, skipping`);
        continue;
      }

      await client.query(
        `INSERT INTO events (alert_id, timestamp, meta) VALUES ($1, $2, $3)`,
        [newAlertId, event.timestamp, event.meta]
      );
    }
    console.log(`Migrated ${events.length} events`);

    // Migrate validated_clients
    console.log('Migrating validated_clients...');
    try {
      const clients = sqlite.prepare('SELECT * FROM validated_clients').all();
      console.log(`Found ${clients.length} validated clients`);

      for (const vc of clients) {
        await client.query(
          `INSERT INTO validated_clients (
            token_hash, machine_id, validated_at, expires_at, last_accessed_at, access_count
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (token_hash) DO NOTHING`,
          [
            vc.token_hash,
            vc.machine_id,
            vc.validated_at,
            vc.expires_at,
            vc.last_accessed_at,
            vc.access_count,
          ]
        );
      }
      console.log(`Migrated ${clients.length} validated clients`);
    } catch (err) {
      // Table might not exist in older databases
      console.log('No validated_clients table found, skipping');
    }

    console.log('\nMigration completed successfully!');
    console.log(`Total: ${alerts.length} alerts, ${decisions.length} decisions, ${events.length} events`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();
