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
  ssl: process.env.POSTGRES_SSL === 'true'
    ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
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
  received_at TEXT NOT NULL,
  simulated BOOLEAN DEFAULT FALSE,
  remediation BOOLEAN DEFAULT FALSE,
  has_decisions BOOLEAN DEFAULT FALSE,
  replicated BOOLEAN DEFAULT FALSE,
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
  local_audit BOOLEAN DEFAULT FALSE,
  actor TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_scenario ON alerts(scenario);
CREATE INDEX IF NOT EXISTS idx_source_ip ON alerts(source_ip);
CREATE INDEX IF NOT EXISTS idx_received_at ON alerts(received_at);
CREATE INDEX IF NOT EXISTS idx_country_code ON alerts(geo_country_code);
CREATE INDEX IF NOT EXISTS idx_filtered ON alerts(filtered);
CREATE INDEX IF NOT EXISTS idx_machine_id ON alerts(machine_id);
CREATE INDEX IF NOT EXISTS idx_local_audit ON alerts(local_audit);

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

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  timestamp TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_alert ON events(alert_id);

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

CREATE TABLE IF NOT EXISTS analyzer_runs (
  id SERIAL PRIMARY KEY,
  analyzer_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  logs_fetched INTEGER DEFAULT 0,
  alerts_generated INTEGER DEFAULT 0,
  decisions_pushed INTEGER DEFAULT 0,
  error_message TEXT,
  results_json TEXT,
  push_results_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_analyzer_runs_analyzer_id ON analyzer_runs(analyzer_id);
CREATE INDEX IF NOT EXISTS idx_analyzer_runs_started_at ON analyzer_runs(started_at);

CREATE TABLE IF NOT EXISTS analyzer_results (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analyzer_runs(id) ON DELETE CASCADE,
  source_ip TEXT NOT NULL,
  distinct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  first_seen TEXT,
  last_seen TEXT,
  decision_pushed BOOLEAN DEFAULT FALSE,
  decision_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_analyzer_results_run_id ON analyzer_results(run_id);
CREATE INDEX IF NOT EXISTS idx_analyzer_results_source_ip ON analyzer_results(source_ip);

CREATE TABLE IF NOT EXISTS bouncers (
  lapi_server_name TEXT NOT NULL,
  bouncer_name TEXT NOT NULL,
  component_kind TEXT NOT NULL,
  bouncer_type TEXT,
  os_name TEXT,
  os_version TEXT,
  version TEXT,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (lapi_server_name, bouncer_name, component_kind)
);

CREATE TABLE IF NOT EXISTS bouncer_metrics (
  id SERIAL PRIMARY KEY,
  lapi_server_name TEXT NOT NULL,
  component_kind TEXT NOT NULL,
  bouncer_name TEXT NOT NULL,
  active_decisions INTEGER,
  processed_items INTEGER,
  dropped_items INTEGER,
  bytes_processed INTEGER,
  collected_at BIGINT NOT NULL,
  metrics_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bouncer_metrics_server_collected ON bouncer_metrics(lapi_server_name, collected_at);
CREATE INDEX IF NOT EXISTS idx_bouncer_metrics_bouncer_collected ON bouncer_metrics(bouncer_name, collected_at);
CREATE UNIQUE INDEX IF NOT EXISTS bouncer_metrics_unique ON bouncer_metrics(lapi_server_name, bouncer_name, component_kind, collected_at);
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
          replicated, source_scope, source_value, source_ip, source_range,
          source_as_number, source_as_name, source_cn,
          geo_country_code, geo_country_name, geo_city, geo_region,
          geo_latitude, geo_longitude, geo_timezone, geo_isp, geo_org,
          filtered, filter_reasons, forwarded_to_capi, forwarded_at,
          local_audit, actor, raw_json
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37,
          $38, $39, $40
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
          Boolean(alert.replicated),
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
          Boolean(alert.local_audit),
          alert.actor,
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

    // Migrate analyzer_runs (and remap their ids for analyzer_results)
    let analyzerRunCount = 0;
    let analyzerResultCount = 0;
    const analyzerRunIdMap = new Map();
    console.log('Migrating analyzer_runs...');
    try {
      const runs = sqlite.prepare('SELECT * FROM analyzer_runs').all();
      console.log(`Found ${runs.length} analyzer runs`);

      for (const run of runs) {
        const res = await client.query(
          `INSERT INTO analyzer_runs (
            analyzer_id, started_at, completed_at, status,
            logs_fetched, alerts_generated, decisions_pushed,
            error_message, results_json, push_results_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            run.analyzer_id,
            run.started_at,
            run.completed_at,
            run.status,
            run.logs_fetched,
            run.alerts_generated,
            run.decisions_pushed,
            run.error_message,
            run.results_json,
            run.push_results_json,
          ]
        );
        analyzerRunIdMap.set(run.id, res.rows[0].id);
      }
      analyzerRunCount = runs.length;
      console.log(`Migrated ${runs.length} analyzer runs`);
    } catch (err) {
      console.log('No analyzer_runs table found, skipping');
    }

    // Migrate analyzer_results (depends on analyzer_runs id remap)
    console.log('Migrating analyzer_results...');
    try {
      const results = sqlite.prepare('SELECT * FROM analyzer_results').all();
      console.log(`Found ${results.length} analyzer results`);

      for (const r of results) {
        const newRunId = analyzerRunIdMap.get(r.run_id);
        if (!newRunId) {
          console.warn(
            `Warning: Analyzer result ${r.id} references non-existent run ${r.run_id}, skipping`
          );
          continue;
        }

        await client.query(
          `INSERT INTO analyzer_results (
            run_id, source_ip, distinct_count, total_count,
            first_seen, last_seen, decision_pushed, decision_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newRunId,
            r.source_ip,
            r.distinct_count,
            r.total_count,
            r.first_seen,
            r.last_seen,
            Boolean(r.decision_pushed),
            r.decision_id,
          ]
        );
        analyzerResultCount++;
      }
      console.log(`Migrated ${analyzerResultCount} analyzer results`);
    } catch (err) {
      console.log('No analyzer_results table found, skipping');
    }

    // Migrate bouncers (composite primary key, no surrogate id)
    let bouncerCount = 0;
    console.log('Migrating bouncers...');
    try {
      const rows = sqlite.prepare('SELECT * FROM bouncers').all();
      console.log(`Found ${rows.length} bouncers`);

      for (const b of rows) {
        await client.query(
          `INSERT INTO bouncers (
            lapi_server_name, bouncer_name, component_kind, bouncer_type,
            os_name, os_version, version, first_seen_at, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (lapi_server_name, bouncer_name, component_kind) DO NOTHING`,
          [
            b.lapi_server_name,
            b.bouncer_name,
            b.component_kind,
            b.bouncer_type,
            b.os_name,
            b.os_version,
            b.version,
            b.first_seen_at,
            b.last_seen_at,
          ]
        );
        bouncerCount++;
      }
      console.log(`Migrated ${bouncerCount} bouncers`);
    } catch (err) {
      console.log('No bouncers table found, skipping');
    }

    // Migrate bouncer_metrics (snapshots; dedup via unique index)
    let bouncerMetricCount = 0;
    console.log('Migrating bouncer_metrics...');
    try {
      const rows = sqlite.prepare('SELECT * FROM bouncer_metrics').all();
      console.log(`Found ${rows.length} bouncer metric snapshots`);

      for (const m of rows) {
        await client.query(
          `INSERT INTO bouncer_metrics (
            lapi_server_name, component_kind, bouncer_name, active_decisions,
            processed_items, dropped_items, bytes_processed, collected_at, metrics_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (lapi_server_name, bouncer_name, component_kind, collected_at) DO NOTHING`,
          [
            m.lapi_server_name,
            m.component_kind,
            m.bouncer_name,
            m.active_decisions,
            m.processed_items,
            m.dropped_items,
            m.bytes_processed,
            m.collected_at,
            m.metrics_json,
          ]
        );
        bouncerMetricCount++;
      }
      console.log(`Migrated ${bouncerMetricCount} bouncer metric snapshots`);
    } catch (err) {
      console.log('No bouncer_metrics table found, skipping');
    }

    console.log('\nMigration completed successfully!');
    console.log(
      `Total: ${alerts.length} alerts, ${decisions.length} decisions, ${events.length} events, ` +
        `${analyzerRunCount} analyzer runs, ${analyzerResultCount} analyzer results, ` +
        `${bouncerCount} bouncers, ${bouncerMetricCount} bouncer metric snapshots`
    );
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
