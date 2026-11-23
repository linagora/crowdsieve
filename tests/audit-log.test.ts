/**
 * Audit log of manual bans and unbans (GET /api/audit, GET /api/audit/actors).
 *
 * Runs the real storage against a SQLite file created with the schema of a
 * previous release (no audit_* columns, one audit row recorded back then), so
 * the inline migration and the raw_json fallback of old rows are covered too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { initializeDatabase, closeDatabase, getDatabaseContext } from '../src/db/index.js';
import { createStorage, type AlertStorage } from '../src/storage/index.js';
import { createLogger } from '../src/logging.js';
import type { Alert } from '../src/models/alert.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';

const TEST_API_KEY = 'test-api-key-audit-log';
const DB_PATH = path.join(os.tmpdir(), `crowdsieve-audit-log-${process.pid}.db`);

// alerts table as created by 0.6.x, before the audit_* columns.
const LEGACY_ALERTS_DDL = `
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT, machine_id TEXT, scenario TEXT NOT NULL, scenario_hash TEXT,
    scenario_version TEXT, message TEXT, events_count INTEGER, capacity INTEGER,
    leakspeed TEXT, start_at TEXT, stop_at TEXT, created_at TEXT,
    received_at TEXT NOT NULL, simulated INTEGER DEFAULT 0, remediation INTEGER DEFAULT 0,
    has_decisions INTEGER DEFAULT 0, replicated INTEGER DEFAULT 0, source_scope TEXT,
    source_value TEXT, source_ip TEXT, source_range TEXT, source_as_number TEXT,
    source_as_name TEXT, source_cn TEXT, geo_country_code TEXT, geo_country_name TEXT,
    geo_city TEXT, geo_region TEXT, geo_latitude REAL, geo_longitude REAL,
    geo_timezone TEXT, geo_isp TEXT, geo_org TEXT, filtered INTEGER DEFAULT 0,
    filter_reasons TEXT, forwarded_to_capi INTEGER DEFAULT 0, forwarded_at TEXT,
    local_audit INTEGER DEFAULT 0, actor TEXT, raw_json TEXT
  );
`;

function buildConfig(): Config {
  return {
    proxy: { listen_port: 8080, capi_url: 'https://api.crowdsec.net', timeout_ms: 5000 },
    lapi_servers: [],
    storage: { type: 'sqlite', path: DB_PATH, retention_days: 30 },
    logging: { level: 'silent', format: 'json' },
    filters: { mode: 'block', rules: [] },
  } as unknown as Config;
}

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
  }
}

function regularAlert(overrides: Partial<Alert> = {}): Alert {
  const now = new Date().toISOString();
  return {
    uuid: `alert-${Math.random().toString(36).slice(2)}`,
    machine_id: 'agent-1',
    scenario: 'crowdsecurity/ssh-bf',
    message: 'SSH bruteforce',
    events_count: 5,
    start_at: now,
    stop_at: now,
    capacity: 5,
    leakspeed: '10s',
    simulated: false,
    events: [],
    source: { scope: 'ip', value: '198.51.100.244', ip: '198.51.100.244' },
    decisions: [],
    ...overrides,
  } as Alert;
}

let app: FastifyInstance;
let storage: AlertStorage;

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { 'X-API-Key': TEST_API_KEY } });
}

async function setReceivedAt(id: number, iso: string) {
  const { db, schema } = getDatabaseContext();
  const { eq } = await import('drizzle-orm');
  (
    db.update(schema.alerts).set({ receivedAt: iso }).where(eq(schema.alerts.id, id)) as {
      run(): void;
    }
  ).run();
}

beforeAll(async () => {
  removeDbFiles();
  const legacy = new Database(DB_PATH);
  legacy.exec(LEGACY_ALERTS_DDL);
  legacy
    .prepare(
      `INSERT INTO alerts (scenario, message, received_at, source_scope, source_value,
         source_ip, filtered, local_audit, actor, raw_json)
       VALUES ('crowdsieve/manual-audit', 'legacy reason', '2026-01-02T03:04:05.000Z', 'ip',
         '192.0.2.9', '192.0.2.9', 1, 1, 'carol@example.com', ?)`
    )
    .run(
      JSON.stringify({
        kind: 'manual-ban',
        server: 'lapi-old',
        decisionId: 7,
        duration: '24h',
        comment: 'legacy reason',
        ip: '192.0.2.9',
        scope: 'ip',
        actor: 'carol@example.com',
      })
    );
  legacy.close();

  await initializeDatabase(buildConfig(), pino({ level: 'silent' }));
  storage = createStorage();

  process.env.DASHBOARD_API_KEY = TEST_API_KEY;
  app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.decorate('config', buildConfig());
  app.decorate('storage', storage);
  app.decorate('proxyLogger', createLogger({ level: 'silent' }));
  app.decorate('clientValidator', undefined);
  app.decorate('replicationService', undefined as ReplicationService | undefined);
  await app.register(import('../src/proxy/routes/api.js'));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
  removeDbFiles();
});

describe('audit columns migration', () => {
  it('adds audit_server, audit_type and audit_duration to an existing alerts table', () => {
    const db = new Database(DB_PATH, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(alerts)').all() as { name: string }[]).map(
      (c) => c.name
    );
    db.close();
    expect(columns).toEqual(
      expect.arrayContaining(['audit_server', 'audit_type', 'audit_duration'])
    );
  });

  it('reads server and duration of rows recorded before the migration from raw_json', async () => {
    const res = await get('/api/audit?actor=carol%40example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total: 1,
      items: [
        {
          id: expect.any(Number),
          at: '2026-01-02T03:04:05.000Z',
          action: 'ban',
          actor: 'carol@example.com',
          ip: '192.0.2.9',
          server: 'lapi-old',
          type: 'ban',
          duration: '24h',
          reason: 'legacy reason',
        },
      ],
    });
  });
});

describe('GET /api/audit', () => {
  let banId: number;
  let unbanId: number;

  beforeEach(async () => {
    const { db, schema } = getDatabaseContext();
    const { ne } = await import('drizzle-orm');
    // Keep the legacy row, drop everything else between tests.
    (
      db.delete(schema.alerts).where(ne(schema.alerts.actor, 'carol@example.com')) as {
        run(): void;
      }
    ).run();
    (
      db.delete(schema.alerts).where(ne(schema.alerts.localAudit, true)) as {
        run(): void;
      }
    ).run();

    // alice bans 198.51.100.244 for 1h on lapi-qa, then bob unbans it.
    banId = await storage.recordManualBanAuditEvent({
      ip: '198.51.100.244',
      scope: 'ip',
      comment: 'abuse report #42',
      server: 'lapi-qa',
      duration: '1h',
      decisionId: 100,
      actor: 'alice@example.com',
    });
    unbanId = await storage.recordUnbanEvent({
      ip: '198.51.100.244',
      scope: 'ip',
      comment: 'false positive',
      server: 'lapi-qa',
      decisionId: 100,
      actor: 'bob@example.com',
    });
    await setReceivedAt(banId, '2026-11-20T10:00:00.000Z');
    await setReceivedAt(unbanId, '2026-11-20T11:00:00.000Z');
  });

  it('lists the unban and the ban, newest first, with server, type and duration', async () => {
    const res = await get('/api/audit?since=2026-11-01T00:00:00.000Z');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total: 2,
      items: [
        {
          id: unbanId,
          at: '2026-11-20T11:00:00.000Z',
          action: 'unban',
          actor: 'bob@example.com',
          ip: '198.51.100.244',
          server: 'lapi-qa',
          type: null,
          duration: null,
          reason: 'false positive',
        },
        {
          id: banId,
          at: '2026-11-20T10:00:00.000Z',
          action: 'ban',
          actor: 'alice@example.com',
          ip: '198.51.100.244',
          server: 'lapi-qa',
          type: 'ban',
          duration: '1h',
          reason: 'abuse report #42',
        },
      ],
    });
  });

  it('records the remediation type of a captcha ban', async () => {
    const id = await storage.recordManualBanAuditEvent({
      ip: '198.51.100.0/30',
      scope: 'range',
      comment: 'suspicious range',
      server: 'lapi-qa',
      duration: '120m',
      type: 'captcha',
      actor: 'alice@example.com',
    });
    const res = await get('/api/audit?ip=198.51.100.0%2F30');
    expect(res.json().items).toEqual([
      expect.objectContaining({ id, action: 'ban', type: 'captcha', duration: '120m' }),
    ]);
  });

  it('filters by actor', async () => {
    const res = await get('/api/audit?actor=alice%40example.com');
    expect(res.json()).toMatchObject({
      total: 1,
      items: [{ id: banId, actor: 'alice@example.com' }],
    });
  });

  it('filters by action', async () => {
    const bans = (await get('/api/audit?action=ban')).json();
    expect(bans.items.map((i: { action: string }) => i.action)).toEqual(['ban', 'ban']);
    const unbans = (await get('/api/audit?action=unban')).json();
    expect(unbans).toMatchObject({ total: 1, items: [{ id: unbanId }] });
  });

  it('filters by IP or range, exactly', async () => {
    expect((await get('/api/audit?ip=198.51.100.244')).json().total).toBe(2);
    expect((await get('/api/audit?ip=198.51.100.24')).json().total).toBe(0);
  });

  it('filters by period', async () => {
    const res = await get(
      '/api/audit?since=2026-11-20T10:30:00.000Z&until=2026-11-20T12:00:00.000Z'
    );
    expect(res.json()).toMatchObject({ total: 1, items: [{ id: unbanId }] });
  });

  it('paginates with limit and offset and reports the total', async () => {
    const first = (await get('/api/audit?limit=2')).json();
    expect(first.total).toBe(3);
    expect(first.items.map((i: { id: number }) => i.id)).toEqual([unbanId, banId]);
    const second = (await get('/api/audit?limit=2&offset=2')).json();
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);
    expect(second.items[0].actor).toBe('carol@example.com');
  });

  it('never returns regular alerts, even when they carry an actor or an audit scenario', async () => {
    // Round-trip of a manual ban, legitimately attributed to alice.
    await storage.storeAlerts(
      [
        regularAlert({
          scenario: 'crowdsieve/manual',
          events: [{ timestamp: '', meta: [{ key: 'actor', value: 'alice@example.com' }] }],
        } as Partial<Alert>),
        // A signal pretending to be an audit row.
        regularAlert({
          scenario: 'crowdsieve/manual-audit',
          message: 'forged',
          events: [{ timestamp: '', meta: [{ key: 'actor', value: 'mallory@example.com' }] }],
        } as Partial<Alert>),
        regularAlert({ scenario: 'crowdsieve/unban', message: 'forged' }),
      ],
      [
        { filtered: false, matchedFilters: [] },
        { filtered: false, matchedFilters: [] },
        { filtered: true, matchedFilters: [] },
      ]
    );

    const res = (await get('/api/audit?limit=100')).json();
    expect(res.total).toBe(3);
    expect(res.items.map((i: { id: number }) => i.id)).toEqual(
      expect.arrayContaining([banId, unbanId])
    );
    expect(res.items.some((i: { reason: string }) => i.reason === 'forged')).toBe(false);
    expect((await get('/api/audit/actors')).json().actors).not.toContain('mallory@example.com');
  });

  it.each([
    ['action=delete', 400],
    ['ip=not-an-ip', 400],
    ['ip=300.1.1.1', 400],
    ['limit=0', 400],
    ['limit=1001', 400],
    ['offset=-1', 400],
    ['since=yesterday', 400],
    ['since=2019-01-01T00:00:00.000Z', 400],
    [`actor=${'a'.repeat(257)}`, 400],
  ])('rejects %s', async (query, status) => {
    expect((await get(`/api/audit?${query}`)).statusCode).toBe(status);
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/audit/actors', () => {
  it('lists the distinct users of the audit log, sorted', async () => {
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.1',
      scope: 'ip',
      comment: 'x',
      server: 'lapi-qa',
      duration: '4h',
      actor: 'alice@example.com',
    });
    await storage.recordManualBanAuditEvent({
      ip: '203.0.113.2',
      scope: 'ip',
      comment: 'no session',
      server: 'lapi-qa',
      duration: '4h',
      actor: null,
    });

    const res = await get('/api/audit/actors');
    expect(res.statusCode).toBe(200);
    const { actors } = res.json() as { actors: string[] };
    expect(actors).toEqual([...actors].sort());
    expect(new Set(actors).size).toBe(actors.length);
    expect(actors).toEqual(expect.arrayContaining(['alice@example.com', 'carol@example.com']));
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit/actors' });
    expect(res.statusCode).toBe(401);
  });
});
