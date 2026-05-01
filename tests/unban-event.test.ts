/**
 * Unban Event Tests
 *
 * Covers:
 *   - storage.recordUnbanEvent inserts a row with unban=true and the supplied actor
 *   - Stats methods (getStats, getTimeDistributionStats, getDecisionStats) exclude
 *     unban rows so audit events don't pollute alert/decision counts
 *   - queryAlerts still returns unban rows so they appear in listings/timelines
 *   - storeAlerts extracts an `actor` from event meta when present (this is how
 *     the manual ban path threads the dashboard user through the LAPI -> signals
 *     roundtrip and back into the alerts table)
 *   - extractActorHeader normalizes the X-Crowdsieve-Actor header forwarded by
 *     the dashboard
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { createStorage, type AlertStorage } from '../src/storage/index.js';
import type { Alert } from '../src/models/alert.js';
import type { FilterEngineResult } from '../src/filters/types.js';
import { extractActorHeader, MAX_ACTOR_LENGTH } from '../src/proxy/routes/api.js';

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
// in storage-deduplication.test.ts so storage methods exercise the real SQL.
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

describe('Unban event recording', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('inserts a row with local_audit=true, scenario=crowdsieve/unban and the supplied actor', async () => {
    const id = await storage.recordUnbanEvent({
      ip: '203.0.113.5',
      scope: 'ip',
      comment: 'False positive — internal scanner',
      server: 'lapi-prod',
      decisionId: 42,
      actor: 'alice@example.com',
    });

    expect(id).toBeGreaterThan(0);

    const row = sqlite
      .prepare('SELECT scenario, local_audit, actor, message, source_ip, filtered FROM alerts WHERE id = ?')
      .get(id) as {
        scenario: string;
        local_audit: number;
        actor: string | null;
        message: string;
        source_ip: string | null;
        filtered: number;
      };

    expect(row.scenario).toBe('crowdsieve/unban');
    // SQLite stores booleans as 0/1
    expect(row.local_audit).toBe(1);
    expect(row.actor).toBe('alice@example.com');
    expect(row.message).toBe('False positive — internal scanner');
    expect(row.source_ip).toBe('203.0.113.5');
    // Defensive: audit events are pre-flagged as filtered so they never get
    // forwarded to CAPI even if a future signal-forwarding job iterates the table.
    expect(row.filtered).toBe(1);
  });

  it('stores actor as NULL when omitted, an empty string, or whitespace-only', async () => {
    const id1 = await storage.recordUnbanEvent({
      ip: '203.0.113.6',
      scope: 'ip',
      comment: 'Case 1',
      server: 'lapi',
      decisionId: 1,
    });
    const id2 = await storage.recordUnbanEvent({
      ip: '203.0.113.7',
      scope: 'ip',
      comment: 'Case 2',
      server: 'lapi',
      decisionId: 2,
      actor: '',
    });
    const id3 = await storage.recordUnbanEvent({
      ip: '203.0.113.8',
      scope: 'ip',
      comment: 'Case 3',
      server: 'lapi',
      decisionId: 3,
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
    const id = await storage.recordUnbanEvent({
      ip: '203.0.113.20',
      scope: 'ip',
      comment: 'Trimmed actor',
      server: 'lapi',
      decisionId: 50,
      actor: '  alice@example.com  ',
    });
    const row = sqlite
      .prepare('SELECT actor FROM alerts WHERE id = ?')
      .get(id) as { actor: string | null };
    expect(row.actor).toBe('alice@example.com');

    const longActor = 'a'.repeat(500);
    const id2 = await storage.recordUnbanEvent({
      ip: '203.0.113.21',
      scope: 'ip',
      comment: 'Long actor',
      server: 'lapi',
      decisionId: 51,
      actor: longActor,
    });
    const row2 = sqlite
      .prepare('SELECT actor FROM alerts WHERE id = ?')
      .get(id2) as { actor: string | null };
    expect(row2.actor).toHaveLength(MAX_ACTOR_LENGTH);
  });

  it('uses range scope when scope=range and leaves source_ip null', async () => {
    const id = await storage.recordUnbanEvent({
      ip: '203.0.113.0/24',
      scope: 'range',
      comment: 'Range unban',
      server: 'lapi',
      decisionId: 7,
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

describe('Stats exclude unban events; listings include them', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('counts only real alerts in getStats / getTimeDistributionStats and exposes both in queryAlerts', async () => {
    // One regular ban alert
    await storage.storeAlerts([createBanAlert({ uuid: 'real-1' })], noFilter(1));

    // One unban event for the same IP
    await storage.recordUnbanEvent({
      ip: '203.0.113.5',
      scope: 'ip',
      comment: 'mistaken ban',
      server: 'lapi',
      decisionId: 99,
      actor: 'alice@example.com',
    });

    const stats = await storage.getStats();
    expect(stats.total).toBe(1);
    // topScenarios excludes audit-only rows so it stays useful for the stats
    // panel (only `crowdsecurity/ssh-bf` here, not `crowdsieve/unban`).
    expect(stats.topScenarios.map((s) => s.scenario)).not.toContain('crowdsieve/unban');
    expect(stats.topScenarios.map((s) => s.scenario)).toContain('crowdsecurity/ssh-bf');
    // allScenarios is the dropdown source: it MUST surface audit scenarios
    // so the user can filter on them from the timeline.
    const allScenarioNames = stats.allScenarios.map((s) => s.scenario);
    expect(allScenarioNames).toContain('crowdsecurity/ssh-bf');
    expect(allScenarioNames).toContain('crowdsieve/unban');

    const timeStats = await storage.getTimeDistributionStats();
    expect(timeStats.totalAlerts).toBe(1);

    // queryAlerts must surface both rows so the timeline / per-IP history
    // shows the unban event alongside the original ban.
    const all = await storage.queryAlerts({});
    expect(all).toHaveLength(2);

    const unbanRow = all.find((a) => a.scenario === 'crowdsieve/unban');
    expect(unbanRow).toBeDefined();
    expect(unbanRow?.localAudit).toBe(true);
    expect(unbanRow?.actor).toBe('alice@example.com');
  });

  it('getDecisionStats ignores rows joined to unban alerts', async () => {
    // A real ban alert produces an `alerts` row + one `decisions` row.
    // The unban event has no decisions associated. getDecisionStats joins
    // decisions to alerts and must filter out the unban side, so the result
    // should reflect exactly the 1 ban decision.
    await storage.storeAlerts([createBanAlert({ uuid: 'real-2' })], noFilter(1));
    await storage.recordUnbanEvent({
      ip: '203.0.113.5',
      scope: 'ip',
      comment: 'unban',
      server: 'lapi',
      decisionId: 1,
      actor: 'alice',
    });

    const decisionStats = await storage.getDecisionStats();
    expect(decisionStats).toBeDefined();
    // Exactly one decision (from the ban alert). The unban row does not pull
    // in any decision rows because recordUnbanEvent never inserts into the
    // decisions table.
    expect(decisionStats.totalDecisions).toBe(1);
    // All breakdown buckets should reflect the single real ban decision.
    expect(decisionStats.topScenarios.length).toBeGreaterThanOrEqual(1);
    expect(decisionStats.topScenarios[0].scenario).toBe('crowdsecurity/ssh-bf');
    expect(decisionStats.topScenarios[0].count).toBe(1);
  });
});

describe('storeAlerts extracts actor from event meta', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('writes actor to the alerts.actor column when an event meta entry has key=actor', async () => {
    const alert = createBanAlert({
      uuid: 'with-actor',
      events: [
        {
          timestamp: new Date().toISOString(),
          meta: [
            { key: 'source', value: 'crowdsieve-dashboard' },
            { key: 'reason', value: 'Manual ban from test' },
            { key: 'actor', value: 'carol@example.com' },
          ],
        },
      ],
    });

    await storage.storeAlerts([alert], noFilter(1));

    const rows = sqlite
      .prepare('SELECT actor FROM alerts WHERE uuid = ?')
      .all('with-actor') as Array<{ actor: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('carol@example.com');
  });

  it('leaves actor null when no event meta carries it', async () => {
    const alert = createBanAlert({ uuid: 'no-actor', events: [] });
    await storage.storeAlerts([alert], noFilter(1));

    const row = sqlite
      .prepare('SELECT actor FROM alerts WHERE uuid = ?')
      .get('no-actor') as { actor: string | null };
    expect(row.actor).toBeNull();
  });

  it('truncates excessive actor values to MAX_ACTOR_LENGTH', async () => {
    const huge = 'x'.repeat(MAX_ACTOR_LENGTH + 100);
    const alert = createBanAlert({
      uuid: 'huge-actor',
      events: [
        {
          timestamp: new Date().toISOString(),
          meta: [{ key: 'actor', value: huge }],
        },
      ],
    });
    await storage.storeAlerts([alert], noFilter(1));

    const row = sqlite
      .prepare('SELECT actor FROM alerts WHERE uuid = ?')
      .get('huge-actor') as { actor: string | null };
    expect(row.actor).toHaveLength(MAX_ACTOR_LENGTH);
  });
});

describe('extractActorHeader', () => {
  it('returns null for missing/empty/whitespace-only inputs', () => {
    expect(extractActorHeader(undefined)).toBeNull();
    expect(extractActorHeader('')).toBeNull();
    expect(extractActorHeader('   ')).toBeNull();
    expect(extractActorHeader([])).toBeNull();
  });

  it('returns the trimmed first entry for array-valued headers', () => {
    expect(extractActorHeader(['  alice@example.com  ', 'bob'])).toBe('alice@example.com');
  });

  it('skips empty/whitespace entries and returns the first usable one', () => {
    expect(extractActorHeader(['', '  ', '  carol@example.com', 'dave'])).toBe('carol@example.com');
  });

  it('truncates to MAX_ACTOR_LENGTH', () => {
    const big = 'a'.repeat(MAX_ACTOR_LENGTH + 50);
    const out = extractActorHeader(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(MAX_ACTOR_LENGTH);
  });
});
