/**
 * Filter rule names saved with stored alerts (SQLite): the `filter_rules`
 * column, its migration, the `rule` alert query filter and the per-rule
 * counts of getFilterRuleStats.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { initializeDatabase, closeDatabase, getDatabaseContext } from '../src/db/index.js';
import { createStorage } from '../src/storage/index.js';
import { FilterEngine } from '../src/filters/index.js';
import { loadFiltersFromDirectory, type Config } from '../src/config/index.js';
import type { Alert } from '../src/models/alert.js';

const logger = pino({ level: 'silent' });
const FILTERS_DIR = path.join(__dirname, '../config/filters.d');

let tmpDir: string;

function configFor(dbPath: string): Config {
  return { storage: { type: 'sqlite', path: dbPath, retention_days: 30 } } as Config;
}

function makeAlert(ip: string, overrides: Partial<Alert> = {}): Alert {
  const now = new Date().toISOString();
  return {
    uuid: `rule-stats-${Math.random().toString(36).slice(2)}`,
    machine_id: 'm1',
    scenario: 'crowdsecurity/ssh-bf',
    message: 'test',
    events_count: 1,
    start_at: now,
    stop_at: now,
    simulated: false,
    events: [],
    source: { scope: 'Ip', value: ip, ip },
    decisions: [{ origin: 'crowdsec', type: 'ban', scope: 'Ip', value: ip, duration: '4h' }],
    ...overrides,
  } as Alert;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsieve-rule-stats-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('filter_rules migration', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('adds the column to an existing alerts table and keeps old rows with NULL', async () => {
    const dbPath = path.join(tmpDir, 'old.db');
    const old = new Database(dbPath);
    // Alerts table as created by 0.6.x (no filter_rules column)
    old.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, machine_id TEXT, scenario TEXT NOT NULL,
        scenario_hash TEXT, scenario_version TEXT, message TEXT, events_count INTEGER,
        capacity INTEGER, leakspeed TEXT, start_at TEXT, stop_at TEXT, created_at TEXT,
        received_at TEXT NOT NULL, simulated INTEGER DEFAULT 0, remediation INTEGER DEFAULT 0,
        has_decisions INTEGER DEFAULT 0, replicated INTEGER DEFAULT 0, source_scope TEXT,
        source_value TEXT, source_ip TEXT, source_range TEXT, source_as_number TEXT,
        source_as_name TEXT, source_cn TEXT, geo_country_code TEXT, geo_country_name TEXT,
        geo_city TEXT, geo_region TEXT, geo_latitude REAL, geo_longitude REAL,
        geo_timezone TEXT, geo_isp TEXT, geo_org TEXT, filtered INTEGER DEFAULT 0,
        filter_reasons TEXT, forwarded_to_capi INTEGER DEFAULT 0, forwarded_at TEXT,
        local_audit INTEGER DEFAULT 0, actor TEXT, raw_json TEXT
      );
      INSERT INTO alerts (scenario, received_at, source_ip, filtered, filter_reasons)
      VALUES ('crowdsecurity/ssh-bf', '${new Date().toISOString()}', '10.0.0.1', 1,
              '["source.ip in CIDR 10.0.0.0/8"]');
    `);
    old.close();

    await initializeDatabase(configFor(dbPath), logger);
    const storage = createStorage();

    const [legacy] = await storage.queryAlerts({});
    expect(legacy.sourceIp).toBe('10.0.0.1');
    expect(legacy.filterRules).toBeNull();

    // Legacy alerts are counted in the totals but under no rule
    const stats = await storage.getFilterRuleStats();
    expect(stats).toEqual({ total: 1, filtered: 1, byRule: [] });
    expect(await storage.queryAlerts({ rule: 'internal-ips' })).toEqual([]);
  });
});

describe('filter rule names (SQLite)', () => {
  const storage = createStorage();
  const { filters } = loadFiltersFromDirectory(FILTERS_DIR);
  const engine = new FilterEngine('block', filters);

  async function store(alerts: Alert[]) {
    await storage.storeAlerts(alerts, engine.process(alerts).filterDetails);
  }

  beforeAll(async () => {
    await initializeDatabase(configFor(path.join(tmpDir, 'stats.db')), logger);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(() => {
    const { db, schema } = getDatabaseContext();
    (db.delete(schema.decisions) as unknown as { run(): void }).run();
    (db.delete(schema.alerts) as unknown as { run(): void }).run();
  });

  it('stores the names of the matched rules, or NULL when none matched', async () => {
    await store([
      makeAlert('10.1.2.3'),
      makeAlert('192.0.2.1'),
      makeAlert('172.16.0.9', { simulated: true, decisions: [] }),
    ]);
    const rows = await storage.queryAlerts({});
    const byIp = Object.fromEntries(rows.map((r) => [r.sourceIp, r.filterRules]));
    expect(byIp['10.1.2.3']).toBe('["internal-ips"]');
    expect(byIp['192.0.2.1']).toBeNull();
    expect(JSON.parse(byIp['172.16.0.9'] as string)).toEqual([
      'no-decision',
      'simulated',
      'internal-ips',
    ]);
  });

  it('filters alerts by exact rule name', async () => {
    await store([
      makeAlert('10.1.2.3'),
      makeAlert('10.1.2.4', { decisions: [] }),
      makeAlert('192.0.2.1'),
    ]);
    const internal = await storage.queryAlerts({ rule: 'internal-ips' });
    expect(internal.map((a) => a.sourceIp).sort()).toEqual(['10.1.2.3', '10.1.2.4']);
    const noDecision = await storage.queryAlerts({ rule: 'no-decision' });
    expect(noDecision.map((a) => a.sourceIp)).toEqual(['10.1.2.4']);
    // Exact element match, not a substring of a name
    expect(await storage.queryAlerts({ rule: 'internal' })).toEqual([]);
    expect(await storage.queryAlerts({ rule: '%' })).toEqual([]);
    // Combines with the other filters
    expect(await storage.queryAlerts({ rule: 'internal-ips', filtered: false })).toEqual([]);
  });

  it('counts alerts per rule with the last match, excluding audit rows', async () => {
    await store([makeAlert('10.1.2.3'), makeAlert('10.1.2.4'), makeAlert('192.168.1.1')]);
    await store([makeAlert('10.9.9.9', { decisions: [] }), makeAlert('198.51.100.7')]);
    // Audit rows are stored with filtered=true but never carry rule names,
    // and are left out of the totals
    await storage.recordManualBanAuditEvent({
      ip: '10.5.5.5',
      scope: 'ip',
      comment: 'manual',
      server: 'lapi',
      duration: '4h',
    });
    await storage.recordUnbanEvent({
      ip: '10.5.5.5',
      scope: 'ip',
      comment: 'unban',
      server: 'lapi',
      decisionId: 1,
    });

    const stats = await storage.getFilterRuleStats();
    expect(stats.total).toBe(5);
    expect(stats.filtered).toBe(4);
    expect(stats.byRule.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: 'internal-ips', count: 4 },
      { name: 'no-decision', count: 1 },
    ]);
    const internal = stats.byRule[0];
    const rows = await storage.queryAlerts({ rule: 'internal-ips' });
    expect(internal.lastMatchedAt).toBe(rows[0].receivedAt);
  });

  it('only counts alerts received since the given date', async () => {
    await store([makeAlert('10.1.2.3')]);
    const { db, schema } = getDatabaseContext();
    (
      db.update(schema.alerts).set({ receivedAt: '2024-01-01T00:00:00.000Z' }) as unknown as {
        run(): void;
      }
    ).run();
    await store([makeAlert('10.1.2.4')]);

    const all = await storage.getFilterRuleStats();
    expect(all.byRule).toEqual([expect.objectContaining({ name: 'internal-ips', count: 2 })]);
    const recent = await storage.getFilterRuleStats(new Date(Date.now() - 86400_000));
    expect(recent.total).toBe(1);
    expect(recent.byRule).toEqual([expect.objectContaining({ name: 'internal-ips', count: 1 })]);
    const none = await storage.getFilterRuleStats(new Date(Date.now() + 1000));
    expect(none).toEqual({ total: 0, filtered: 0, byRule: [] });
  });
});
