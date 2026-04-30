/**
 * Manual Ban Audit Event Tests
 *
 * Covers:
 *   - storage.recordManualBanAuditEvent inserts a row with local_audit=true,
 *     scenario='crowdsieve/manual-audit', the sanitized actor, the comment,
 *     and the duration encoded in raw_json
 *   - Stats methods (getStats, getTimeDistributionStats, getDecisionStats)
 *     exclude manual-ban audit rows so audit events don't pollute counts
 *   - queryAlerts still returns manual-ban audit rows so they appear in
 *     listings/timelines
 *   - The decisionId is recorded in raw_json when supplied and is null
 *     otherwise (LAPI didn't return a parsable id)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { createStorage, type AlertStorage } from '../src/storage/index.js';
import type { Alert } from '../src/models/alert.js';
import type { FilterEngineResult } from '../src/filters/types.js';
import { MAX_ACTOR_LENGTH } from '../src/proxy/routes/api.js';

// Shared in-memory database; recreated per test to keep tests independent.
let sqlite: Database.Database;

function setupTestDatabase() {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Mirror the production DDL — including local_audit + actor — so the drizzle
  // schema can insert without "no such column" errors.
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
      replicated INTEGER DEFAULT 0,
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
      local_audit INTEGER DEFAULT 0,
      actor TEXT,
      raw_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_uuid ON alerts(uuid) WHERE uuid IS NOT NULL;

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
  `);
}

// Mock getDatabaseContext to use our test database. Mirrors the pattern used
// in storage-deduplication.test.ts and unban-event.test.ts so storage methods
// exercise the real SQL.
vi.mock('../src/db/index.js', () => ({
  getDatabaseContext: () => {
    const db = drizzle(sqlite, { schema });
    return { db, schema, isPostgres: false };
  },
}));

function createBanAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    uuid: `alert-${Math.random().toString(36).slice(2)}`,
    scenario: 'crowdsecurity/ssh-bf',
    scenario_hash: 'abc123',
    scenario_version: '1.0.0',
    message: 'SSH bruteforce',
    events_count: 5,
    start_at: new Date().toISOString(),
    stop_at: new Date().toISOString(),
    capacity: 5,
    leakspeed: '10s',
    simulated: false,
    events: [],
    source: { scope: 'ip', value: '198.51.100.42', ip: '198.51.100.42' },
    decisions: [
      {
        origin: 'crowdsec',
        type: 'ban',
        scope: 'ip',
        value: '198.51.100.42',
        duration: '4h',
        scenario: 'crowdsecurity/ssh-bf',
      },
    ],
    ...overrides,
  };
}

function noFilter(count: number): FilterEngineResult['filterDetails'] {
  return Array.from({ length: count }, () => ({ filtered: false, matchedFilters: [] }));
}

describe('Manual ban audit event recording', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('inserts a row with local_audit=true, scenario=crowdsieve/manual-audit and the supplied actor', async () => {
    const id = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.50',
      scope: 'ip',
      comment: 'Spam from this IP',
      server: 'lapi-prod',
      duration: '4h',
      decisionId: 4242,
      actor: 'alice@example.com',
    });

    expect(id).toBeGreaterThan(0);

    const row = sqlite
      .prepare(
        'SELECT scenario, local_audit, actor, message, source_ip, filtered, forwarded_to_capi, raw_json FROM alerts WHERE id = ?'
      )
      .get(id) as {
        scenario: string;
        local_audit: number;
        actor: string | null;
        message: string;
        source_ip: string | null;
        filtered: number;
        forwarded_to_capi: number;
        raw_json: string;
      };

    expect(row.scenario).toBe('crowdsieve/manual-audit');
    // SQLite stores booleans as 0/1
    expect(row.local_audit).toBe(1);
    expect(row.actor).toBe('alice@example.com');
    expect(row.message).toBe('Spam from this IP');
    expect(row.source_ip).toBe('203.0.113.50');
    // Defensive: audit events are pre-flagged as filtered so they never get
    // forwarded to CAPI even if a future signal-forwarding job iterates the table.
    expect(row.filtered).toBe(1);
    expect(row.forwarded_to_capi).toBe(0);

    // raw_json should encode the manual-ban kind, duration, decisionId and
    // the rest of the audit payload so downstream consumers can render it.
    const parsed = JSON.parse(row.raw_json) as {
      kind: string;
      server: string;
      decisionId: number | null;
      duration: string | null;
      comment: string;
      ip: string;
      scope: string;
      actor: string | null;
    };
    expect(parsed.kind).toBe('manual-ban');
    expect(parsed.server).toBe('lapi-prod');
    expect(parsed.decisionId).toBe(4242);
    expect(parsed.duration).toBe('4h');
    expect(parsed.comment).toBe('Spam from this IP');
    expect(parsed.ip).toBe('203.0.113.50');
    expect(parsed.scope).toBe('ip');
    expect(parsed.actor).toBe('alice@example.com');
  });

  it('records decisionId=null in raw_json when LAPI did not return one', async () => {
    const id = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.51',
      scope: 'ip',
      comment: 'No id from LAPI',
      server: 'lapi-prod',
      duration: '1h',
      // decisionId omitted
      actor: 'bob',
    });

    const row = sqlite
      .prepare('SELECT raw_json FROM alerts WHERE id = ?')
      .get(id) as { raw_json: string };
    const parsed = JSON.parse(row.raw_json) as { decisionId: number | null; duration: string };
    expect(parsed.decisionId).toBeNull();
    expect(parsed.duration).toBe('1h');
  });

  it('stores actor as NULL when omitted, an empty string, or whitespace-only', async () => {
    const id1 = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.60',
      scope: 'ip',
      comment: 'Case 1',
      server: 'lapi',
      duration: '4h',
    });
    const id2 = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.61',
      scope: 'ip',
      comment: 'Case 2',
      server: 'lapi',
      duration: '4h',
      actor: '',
    });
    const id3 = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.62',
      scope: 'ip',
      comment: 'Case 3',
      server: 'lapi',
      duration: '4h',
      actor: '   ',
    });

    const rows = sqlite
      .prepare('SELECT id, actor FROM alerts WHERE id IN (?, ?, ?)')
      .all(id1, id2, id3) as Array<{ id: number; actor: string | null }>;

    for (const r of rows) {
      expect(r.actor).toBeNull();
    }
  });

  it('trims and truncates the supplied actor to MAX_ACTOR_LENGTH', async () => {
    const id = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.70',
      scope: 'ip',
      comment: 'Trimmed actor',
      server: 'lapi',
      duration: '4h',
      actor: '  alice@example.com  ',
    });
    const row = sqlite
      .prepare('SELECT actor FROM alerts WHERE id = ?')
      .get(id) as { actor: string | null };
    expect(row.actor).toBe('alice@example.com');

    const longActor = 'a'.repeat(500);
    const id2 = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.71',
      scope: 'ip',
      comment: 'Long actor',
      server: 'lapi',
      duration: '4h',
      actor: longActor,
    });
    const row2 = sqlite
      .prepare('SELECT actor FROM alerts WHERE id = ?')
      .get(id2) as { actor: string | null };
    expect(row2.actor).toHaveLength(MAX_ACTOR_LENGTH);
  });

  it('uses range scope when scope=range and leaves source_ip null', async () => {
    const id = await storage.recordManualBanAuditEvent({
      ip: '203.0.113.0/24',
      scope: 'range',
      comment: 'Range manual ban',
      server: 'lapi',
      duration: '24h',
      actor: 'bob',
    });

    const row = sqlite
      .prepare('SELECT source_scope, source_value, source_ip, source_range FROM alerts WHERE id = ?')
      .get(id) as {
      source_scope: string;
      source_value: string;
      source_ip: string | null;
      source_range: string | null;
    };

    expect(row.source_scope).toBe('range');
    expect(row.source_value).toBe('203.0.113.0/24');
    expect(row.source_ip).toBeNull();
    expect(row.source_range).toBe('203.0.113.0/24');
  });
});

describe('Stats exclude manual-ban audit events; listings include them', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('counts only real alerts in getStats / getTimeDistributionStats and exposes the audit row in queryAlerts', async () => {
    // One regular ban alert
    await storage.storeAlerts([createBanAlert({ uuid: 'real-1' })], noFilter(1));

    // One manual-ban audit event
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.80',
      scope: 'ip',
      comment: 'manual ban from dashboard',
      server: 'lapi',
      duration: '4h',
      decisionId: 99,
      actor: 'alice@example.com',
    });

    const stats = await storage.getStats();
    expect(stats.total).toBe(1);

    const timeStats = await storage.getTimeDistributionStats();
    expect(timeStats.totalAlerts).toBe(1);

    // queryAlerts must surface both rows so the timeline / per-IP history
    // shows the audit entry alongside the original alert.
    const all = await storage.queryAlerts({});
    expect(all).toHaveLength(2);

    const auditRow = all.find((a) => a.scenario === 'crowdsieve/manual-audit');
    expect(auditRow).toBeDefined();
    expect(auditRow?.localAudit).toBe(true);
    expect(auditRow?.actor).toBe('alice@example.com');
  });

  it('getDecisionStats ignores rows joined to manual-ban audit alerts', async () => {
    // A real ban alert produces an `alerts` row + one `decisions` row.
    // The manual-ban audit event has no decisions associated. getDecisionStats
    // joins decisions to alerts and must filter out the audit side, so the
    // result should reflect exactly the 1 ban decision.
    await storage.storeAlerts([createBanAlert({ uuid: 'real-2' })], noFilter(1));
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.81',
      scope: 'ip',
      comment: 'manual ban',
      server: 'lapi',
      duration: '4h',
      actor: 'alice',
    });

    const decisionStats = await storage.getDecisionStats();
    expect(decisionStats).toBeDefined();
    // Exactly one decision (from the ban alert). The audit row does not pull
    // in any decision rows because recordManualBanAuditEvent never inserts
    // into the decisions table.
    expect(decisionStats.totalDecisions).toBe(1);
    // All breakdown buckets should reflect the single real ban decision.
    expect(decisionStats.topScenarios.length).toBeGreaterThanOrEqual(1);
    expect(decisionStats.topScenarios[0].scenario).toBe('crowdsecurity/ssh-bf');
    expect(decisionStats.topScenarios[0].count).toBe(1);
  });

  it('excludes both unban and manual-ban audit rows from stats simultaneously', async () => {
    await storage.storeAlerts([createBanAlert({ uuid: 'real-3' })], noFilter(1));
    await storage.recordUnbanEvent({
      ip: '203.0.113.90',
      scope: 'ip',
      comment: 'unban',
      server: 'lapi',
      decisionId: 1,
      actor: 'alice',
    });
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.91',
      scope: 'ip',
      comment: 'manual ban',
      server: 'lapi',
      duration: '4h',
      actor: 'bob',
    });

    const stats = await storage.getStats();
    expect(stats.total).toBe(1);

    const all = await storage.queryAlerts({});
    expect(all).toHaveLength(3);
  });

  it('surfaces unban + manual ban audit rows in per-IP history (queryAlerts by sourceIp)', async () => {
    await storage.recordUnbanEvent({
      ip: '198.51.100.42',
      scope: 'ip',
      comment: 'admin removed ban',
      server: 'lapi',
      decisionId: 1,
      actor: 'alice',
    });
    await storage.recordManualBanAuditEvent({
      ip: '198.51.100.42',
      scope: 'ip',
      comment: 'admin issued ban',
      server: 'lapi',
      duration: '4h',
      actor: 'alice',
    });
    // Decoy: a row for a different IP that must NOT appear in the per-IP query.
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.99',
      scope: 'ip',
      comment: 'unrelated',
      server: 'lapi',
      duration: '4h',
      actor: 'bob',
    });

    const history = await storage.queryAlerts({ sourceIp: '198.51.100.42' });
    expect(history).toHaveLength(2);
    const scenarios = history.map((r) => r.scenario).sort();
    expect(scenarios).toEqual(['crowdsieve/manual-audit', 'crowdsieve/unban']);
    // Audit rows must carry the local_audit flag so the UI renders the badge.
    for (const row of history) {
      expect(row.localAudit).toBe(true);
    }
  });
});
