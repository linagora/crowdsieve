/**
 * Tests for the POST /v1/usage-metrics interception route and the bouncer
 * metrics storage round-trip.
 *
 * Covers:
 * - Route persists per-bouncer rows from a typical CrowdSec payload, then
 *   forwards the same body to CAPI when forwarding is enabled.
 * - Missing Authorization is rejected with 401.
 * - With `forward_enabled=false` the row is still persisted but no fetch
 *   to CAPI is made (test mode).
 * - When CAPI returns a 5xx, the row is still persisted and the response
 *   status reflects CAPI's status.
 * - Storage round-trip (saveBouncerMetrics + getBouncerMetrics with filters,
 *   getBouncerNames, cleanupBouncerMetrics, getStats.blockedRequests).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import * as schema from '../src/db/schema.js';
import {
  createStorage,
  type AlertStorage,
  type NewBouncerMetric,
} from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import { createLogger } from '../src/logging.js';
import { buildRowsFromPayload } from '../src/metrics/parse.js';

let sqlite: Database.Database;

function setupTestDatabase() {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT,
      machine_id TEXT,
      scenario TEXT NOT NULL DEFAULT '',
      scenario_hash TEXT,
      scenario_version TEXT,
      message TEXT,
      events_count INTEGER,
      capacity INTEGER,
      leakspeed TEXT,
      start_at TEXT,
      stop_at TEXT,
      created_at TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    CREATE TABLE IF NOT EXISTS bouncer_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lapi_server_name TEXT NOT NULL,
      component_kind TEXT NOT NULL,
      bouncer_name TEXT NOT NULL,
      bouncer_type TEXT,
      os_name TEXT,
      os_version TEXT,
      version TEXT,
      active_decisions INTEGER,
      processed_items INTEGER,
      dropped_items INTEGER,
      bytes_processed INTEGER,
      collected_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bouncer_metrics_server_collected
      ON bouncer_metrics(lapi_server_name, collected_at);
    CREATE INDEX IF NOT EXISTS idx_bouncer_metrics_bouncer_collected
      ON bouncer_metrics(bouncer_name, collected_at);
    CREATE UNIQUE INDEX IF NOT EXISTS bouncer_metrics_unique
      ON bouncer_metrics(lapi_server_name, bouncer_name, component_kind, collected_at);
  `);
}

vi.mock('../src/db/index.js', () => ({
  getDatabaseContext: () => {
    const db = drizzle(sqlite, { schema });
    return { db, schema, isPostgres: false };
  },
}));

function createMockConfig(over: Partial<Config> = {}): Config {
  const base: Config = {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://capi.example.test',
      timeout_ms: 5000,
      forward_enabled: true,
    },
    lapi_servers: [],
    storage: { type: 'sqlite', path: ':memory:', retention_days: 30 },
    logging: { level: 'silent', format: 'json' },
    filters: { mode: 'block', rules: [] },
    client_validation: {
      enabled: false,
      cache_ttl_seconds: 604800,
      cache_ttl_error_seconds: 3600,
      validation_timeout_ms: 5000,
      max_memory_entries: 1000,
      fail_closed: false,
    },
    analyzers: {
      enabled: false,
      config_dir: './config/analyzers.d',
      default_interval: '3h',
      default_lookback: '3h',
      default_targets: 'all',
      whitelist: [],
      sources: {},
    },
    bouncer_metrics: { retention_days: 30 },
  };
  // Shallow merge per top-level key (sufficient for the few overrides we use).
  return { ...base, ...over };
}

function makeUsageMetricsPayload() {
  return {
    remediation_components: [
      {
        name: 'firewall-bouncer-1',
        type: 'firewall-bouncer',
        os: { name: 'linux', version: '12' },
        version: '0.1.0',
        metrics: [
          { name: 'active_decisions', value: 42, labels: { ip_type: 'ipv4' } },
          { name: 'active_decisions', value: 8, labels: { ip_type: 'ipv6' } },
          { name: 'dropped', value: 100, labels: {} },
          { name: 'processed', value: 500, labels: {} },
          { name: 'bytes', value: 1024, labels: {} },
          { name: 'unknown_metric', value: 7, labels: {} },
        ],
      },
    ],
    log_processors: [
      {
        name: 'lp-1',
        type: 'crowdsec',
        os: { name: 'linux', version: '12' },
        version: '1.6.0',
        // Wrapped form: items[] inside the metrics[] block (current LP shape).
        metrics: [{ items: [{ name: 'processed', value: 999, labels: {} }] }],
      },
    ],
  };
}

/**
 * Build a CrowdSec-style JWT (signature ignored — we only decode the payload).
 * Header is fixed; payload is whatever the caller passes.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(payload)}.signature`;
}

async function buildApp(config: Config, storage: AlertStorage): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.setSchemaErrorFormatter((errors, dataVar) => {
    const first = errors[0];
    const path = first?.instancePath || '';
    const message = first?.message || 'Invalid request';
    const err = new Error(`${dataVar}${path} ${message}`.trim()) as Error & {
      statusCode?: number;
    };
    err.statusCode = 400;
    return err;
  });
  app.decorate('config', config);
  app.decorate('storage', storage);
  app.decorate('proxyLogger', createLogger({ level: 'silent' }));
  app.decorate('clientValidator', undefined);
  app.decorate('replicationService', undefined);
  // filterEngine is required by the FastifyInstance type but not used by this route.
  app.decorate('filterEngine', {} as unknown);
  await app.register(import('../src/proxy/routes/usage-metrics.js'));
  await app.ready();
  return app;
}

describe('POST /v1/usage-metrics route', () => {
  let storage: AlertStorage;
  let app: FastifyInstance;
  let originalFetch: typeof fetch;

  beforeAll(() => {
    process.env.DASHBOARD_API_KEY = 'test-key-usage-metrics';
  });

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await app?.close();
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('persists rows and forwards to CAPI on successful relay', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toBe('https://capi.example.test/v1/usage-metrics');
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    app = await buildApp(createMockConfig(), storage);
    const token = makeJwt({ id: 'lapi-machine-A', exp: 9_999_999_999 });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const rows = await storage.getBouncerMetrics({});
    expect(rows).toHaveLength(2);

    const remediation = rows.find((r) => r.componentKind === 'remediation');
    const logProc = rows.find((r) => r.componentKind === 'log_processor');

    // Hot counters from a real-shaped payload
    expect(remediation?.bouncerName).toBe('firewall-bouncer-1');
    expect(remediation?.lapiServerName).toBe('lapi-machine-A');
    expect(remediation?.activeDecisions).toBe(50); // 42 + 8 summed across labels
    expect(remediation?.processedItems).toBe(500);
    expect(remediation?.droppedItems).toBe(100);
    expect(remediation?.bytesProcessed).toBe(1024);

    // Wrapped form (`metrics[].items[]`) is also unwrapped correctly.
    expect(logProc?.bouncerName).toBe('lp-1');
    expect(logProc?.processedItems).toBe(999);
  });

  it('rejects requests without Authorization with 401', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    app = await buildApp(createMockConfig(), storage);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: { 'Content-Type': 'application/json' },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await storage.getBouncerMetrics({});
    expect(rows).toHaveLength(0);
  });

  it('maps JWT machine_id to friendly LAPI server name via source_machine_ids', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = createMockConfig({
      lapi_servers: [
        {
          name: 'sso',
          url: 'http://lapi-sso.example.test',
          api_key: 'key1',
          source_machine_ids: ['hex-machine-id-here'],
          replicate_decisions: false,
        },
      ],
    });
    app = await buildApp(cfg, storage);

    const token = makeJwt({ id: 'hex-machine-id-here', exp: 9_999_999_999 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(200);
    const rows = await storage.getBouncerMetrics({});
    expect(rows.length).toBeGreaterThan(0);
    // All rows must be tagged with the friendly name, not the raw machine_id.
    expect(rows.every((r) => r.lapiServerName === 'sso')).toBe(true);
  });

  it('falls back to raw machine_id when no source_machine_ids match', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = createMockConfig({
      lapi_servers: [
        {
          name: 'other-server',
          url: 'http://lapi-other.example.test',
          api_key: 'key2',
          source_machine_ids: ['different-machine-id'],
          replicate_decisions: false,
        },
      ],
    });
    app = await buildApp(cfg, storage);

    const token = makeJwt({ id: 'unmatched-machine-id', exp: 9_999_999_999 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(200);
    const rows = await storage.getBouncerMetrics({});
    expect(rows.length).toBeGreaterThan(0);
    // Falls back to the raw JWT id when no mapping exists.
    expect(rows.every((r) => r.lapiServerName === 'unmatched-machine-id')).toBe(true);
  });

  it('persists rows but does not forward when forward_enabled=false', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = createMockConfig();
    cfg.proxy.forward_enabled = false;
    app = await buildApp(cfg, storage);

    const token = makeJwt({ id: 'lapi-test-mode' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = await storage.getBouncerMetrics({});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.lapiServerName === 'lapi-test-mode')).toBe(true);
  });

  it('persists rows and surfaces upstream status when CAPI returns 502', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream down', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    app = await buildApp(createMockConfig(), storage);
    const token = makeJwt({ id: 'lapi-with-bad-capi' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage-metrics',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      payload: makeUsageMetricsPayload(),
    });

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();

    // Persistence happens BEFORE forwarding — so a CAPI outage cannot drop
    // metrics. This is the documented ordering in usage-metrics.ts.
    const rows = await storage.getBouncerMetrics({});
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('buildRowsFromPayload (parser)', () => {
  it('handles flat metrics[] form', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [{ name: 'dropped', value: 5 }, { name: 'processed', value: 10 }],
          },
        ],
      },
      1000
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].droppedItems).toBe(5);
    expect(rows[0].processedItems).toBe(10);
  });

  it('handles wrapped metrics[].items[] form', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      {
        log_processors: [
          {
            name: 'lp',
            metrics: [{ items: [{ name: 'processed', value: 7 }] }],
          },
        ],
      },
      1000
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].processedItems).toBe(7);
  });

  it('skips components without a name', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      { remediation_components: [{ metrics: [{ name: 'dropped', value: 1 }] }] },
      1000
    );
    expect(rows).toHaveLength(0);
  });

  it('block form emits one row per block', () => {
    // Two blocks: each block becomes its own row keyed by its timestamp.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              {
                meta: { utc_now_timestamp: 1730123456, window_size_seconds: 900 },
                items: [{ name: 'dropped', value: 100, labels: { ip_type: 'ipv4' } }],
              },
              {
                meta: { utc_now_timestamp: 1730125256, window_size_seconds: 900 },
                items: [{ name: 'dropped', value: 250, labels: { ip_type: 'ipv4' } }],
              },
            ],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].droppedItems).toBe(100);
    expect(rows[0].collectedAt).toBe(1730123456 * 1000);
    expect(rows[1].droppedItems).toBe(250);
    expect(rows[1].collectedAt).toBe(1730125256 * 1000);
  });

  it('block form sums per-label items within a block (single block)', () => {
    // One block with two dropped items for different labels → total 250.
    // Within ONE block, per-label items always sum.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              {
                meta: { utc_now_timestamp: 1730123456 },
                items: [
                  { name: 'dropped', value: 200, labels: { ip_type: 'ipv4' } },
                  { name: 'dropped', value: 50, labels: { ip_type: 'ipv6' } },
                ],
              },
            ],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].droppedItems).toBe(250);
  });

  it('blocks without meta get unique synthetic timestamps', () => {
    // Two blocks without meta. Each becomes its own row with a synthetic
    // collectedAt derived from the fallback + block index.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              { items: [{ name: 'dropped', value: 100, labels: {} }] },
              { items: [{ name: 'dropped', value: 200, labels: {} }] },
            ],
          },
        ],
      },
      5000
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].droppedItems).toBe(100);
    expect(rows[0].collectedAt).toBe(5000); // fallback + index 0
    expect(rows[1].droppedItems).toBe(200);
    expect(rows[1].collectedAt).toBe(5001); // fallback + index 1
  });

  it('per-label items within a block are summed into one row', () => {
    // One block with two dropped items for different labels → total 250 in one row.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              {
                meta: { utc_now_timestamp: 1730123456 },
                items: [
                  { name: 'dropped', value: 200, labels: { ip_type: 'ipv4' } },
                  { name: 'dropped', value: 50, labels: { ip_type: 'ipv6' } },
                ],
              },
            ],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].droppedItems).toBe(250);
  });

  it('each block carries its own counters independently (two blocks → two rows)', () => {
    // Block 1: dropped=100, active_decisions=10
    // Block 2: dropped=200, active_decisions=15
    // Each block is stored as its own row — counters are NOT summed or shared.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              {
                meta: { utc_now_timestamp: 1730123456, window_size_seconds: 900 },
                items: [
                  { name: 'dropped', value: 100, labels: {} },
                  { name: 'active_decisions', value: 10, labels: {} },
                ],
              },
              {
                meta: { utc_now_timestamp: 1730125256, window_size_seconds: 900 },
                items: [
                  { name: 'dropped', value: 200, labels: {} },
                  { name: 'active_decisions', value: 15, labels: {} },
                ],
              },
            ],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].droppedItems).toBe(100);
    expect(rows[0].activeDecisions).toBe(10);
    expect(rows[1].droppedItems).toBe(200);
    expect(rows[1].activeDecisions).toBe(15);
  });

  it('canonicalizes bouncer name by stripping trailing @<ipv4>', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw-bouncer-1@172.22.0.3',
            metrics: [{ name: 'dropped', value: 5 }],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bouncerName).toBe('fw-bouncer-1');
  });

  it('canonicalizes bouncer name by stripping trailing @<ipv6>', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          { name: 'svc@2001:db8::1', metrics: [{ name: 'dropped', value: 1 }] },
          { name: 'svc@[fe80::1]', metrics: [{ name: 'dropped', value: 1 }] },
        ],
      },
      0
    );
    expect(rows.map((r) => r.bouncerName)).toEqual(['svc', 'svc']);
  });

  it('leaves names without an IP suffix untouched', () => {
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          { name: 'plain-bouncer', metrics: [{ name: 'dropped', value: 1 }] },
          { name: 'svc@hostname', metrics: [{ name: 'dropped', value: 1 }] },
        ],
      },
      0
    );
    expect(rows.map((r) => r.bouncerName)).toEqual(['plain-bouncer', 'svc@hostname']);
  });

  it('empty blocks are skipped', () => {
    // A block with items:[] is a fresh-registration placeholder — do not emit a row.
    // Only the block that has actual items should produce a row.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              { meta: { utc_now_timestamp: 1730123456 }, items: [] },
              { meta: { utc_now_timestamp: 1730125256 }, items: [{ name: 'dropped', value: 7 }] },
            ],
          },
        ],
      },
      0
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].droppedItems).toBe(7);
    expect(rows[0].collectedAt).toBe(1730125256 * 1000);
  });

  it('emits a registration-only row for components with no usable items', () => {
    // Bouncers like LemonLDAP-NG / libwww-perl register with the LAPI and pull
    // decisions, but never POST usage-metrics. CrowdSec still includes them in
    // each relay with `metrics: []`. We must keep them visible (one row with
    // all-zero counters and metricsJson='[]') so the dashboard lists them.
    // The homepage SUM filters on `metrics_json != '[]'` to exclude them.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          { name: 'just-registered', metrics: [] },
          { name: 'has-empty-block', metrics: [{ items: [] }] },
          { name: 'has-data', metrics: [{ items: [{ name: 'dropped', value: 7 }] }] },
        ],
      },
      0
    );
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((r) => [r.bouncerName, r]));
    expect(byName['just-registered'].droppedItems).toBe(0);
    expect(byName['just-registered'].metricsJson).toBe('[]');
    expect(byName['has-empty-block'].droppedItems).toBe(0);
    expect(byName['has-empty-block'].metricsJson).toBe('[]');
    expect(byName['has-data'].droppedItems).toBe(7);
  });

  it('flat form still works (legacy back-compat)', () => {
    // Legacy payload: metrics is a flat array of items with top-level name/value.
    const rows = buildRowsFromPayload(
      'srv1',
      {
        remediation_components: [
          {
            name: 'fw',
            metrics: [
              { name: 'dropped', value: 42 },
              { name: 'processed', value: 100 },
            ],
          },
        ],
      },
      9000
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].droppedItems).toBe(42);
    expect(rows[0].processedItems).toBe(100);
    expect(rows[0].collectedAt).toBe(9000);
  });
});

describe('Bouncer metrics storage', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeRow(over: Partial<NewBouncerMetric> = {}): NewBouncerMetric {
    return {
      lapiServerName: 'srv1',
      componentKind: 'remediation',
      bouncerName: 'fw-1',
      bouncerType: 'firewall-bouncer',
      osName: 'linux',
      osVersion: '12',
      version: '0.1.0',
      activeDecisions: 10,
      processedItems: 100,
      droppedItems: 5,
      bytesProcessed: 2048,
      collectedAt: Date.now(),
      metricsJson: '[{"name":"dropped","value":5}]',
      ...over,
    };
  }

  it('round-trips saveBouncerMetrics and getBouncerMetrics with filters', async () => {
    const now = Date.now();
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'srv1', bouncerName: 'b1', collectedAt: now - 5000 }),
      makeRow({ lapiServerName: 'srv1', bouncerName: 'b2', collectedAt: now - 2000 }),
      makeRow({ lapiServerName: 'srv2', bouncerName: 'b1', collectedAt: now - 1000 }),
    ]);

    const all = await storage.getBouncerMetrics({});
    expect(all).toHaveLength(3);
    // Newest first
    expect(all[0].collectedAt).toBeGreaterThanOrEqual(all[1].collectedAt);

    const onlySrv1 = await storage.getBouncerMetrics({ lapiServerName: 'srv1' });
    expect(onlySrv1).toHaveLength(2);
    expect(onlySrv1.every((r) => r.lapiServerName === 'srv1')).toBe(true);

    const onlyB1 = await storage.getBouncerMetrics({ bouncerName: 'b1' });
    expect(onlyB1).toHaveLength(2);
    expect(onlyB1.every((r) => r.bouncerName === 'b1')).toBe(true);

    const since = await storage.getBouncerMetrics({ since: now - 2500 });
    expect(since).toHaveLength(2);

    const limited = await storage.getBouncerMetrics({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('saveBouncerMetrics handles large batches (>500 rows) without exceeding SQLite variable limit', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 1500 }, (_, i) =>
      makeRow({ bouncerName: `b${i}`, collectedAt: now - i })
    );
    await expect(storage.saveBouncerMetrics(rows)).resolves.toBeUndefined();
    const all = await storage.getBouncerMetrics({ limit: 2000 });
    expect(all).toHaveLength(1500);
  });

  it('getBouncerNames returns distinct (server, bouncer) tuples', async () => {
    const now = Date.now();
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'srv1', bouncerName: 'b1', collectedAt: now }),
      makeRow({ lapiServerName: 'srv1', bouncerName: 'b1', collectedAt: now - 1000 }),
      makeRow({ lapiServerName: 'srv2', bouncerName: 'b1', collectedAt: now }),
      makeRow({ lapiServerName: 'srv1', bouncerName: 'b2', collectedAt: now }),
    ]);

    const names = await storage.getBouncerNames();
    expect(names).toHaveLength(3);
    const keys = names.map((n) => `${n.lapiServerName}::${n.bouncerName}`).sort();
    expect(keys).toEqual(['srv1::b1', 'srv1::b2', 'srv2::b1']);
  });

  it('getStats blockedRequests sums per-window dropped counters across the retention window', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    await storage.saveBouncerMetrics([
      // (serverA, fwBouncer): 5 per-window snapshots — every value is summed.
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'remediation', droppedItems: 100, collectedAt: now - 25 * day }),
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'remediation', droppedItems: 250, collectedAt: now - 20 * day }),
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'remediation', droppedItems: 80,  collectedAt: now - 15 * day }),
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'remediation', droppedItems: 300, collectedAt: now - 10 * day }),
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'remediation', droppedItems: 300, collectedAt: now -  5 * day }),

      // (serverA, nginxBouncer): 2 per-window snapshots.
      makeRow({ lapiServerName: 'serverA', bouncerName: 'nginxBouncer', componentKind: 'remediation', droppedItems: 50,  collectedAt: now - 12 * day }),
      makeRow({ lapiServerName: 'serverA', bouncerName: 'nginxBouncer', componentKind: 'remediation', droppedItems: 170, collectedAt: now -  1 * day }),

      // log_processor row — must be excluded from the total.
      makeRow({ lapiServerName: 'serverA', bouncerName: 'fwBouncer', componentKind: 'log_processor', droppedItems: 999, collectedAt: now - 5 * day }),
    ]);

    const stats = await storage.getStats();
    // fwBouncer:    100 + 250 + 80 + 300 + 300 = 1030
    // nginxBouncer: 50 + 170                    = 220
    // log_processor excluded
    expect(stats.blockedRequests).toBe(1250);

    // Sanity: other fields still exist and are numeric
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.filtered).toBe('number');
    expect(typeof stats.forwarded).toBe('number');
  });

  it('getStats blockedRequests counts a single snapshot directly (no baseline subtraction)', async () => {
    const now = Date.now();
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'serverB', bouncerName: 'singleBouncer', componentKind: 'remediation', droppedItems: 500, collectedAt: now - 1000 }),
    ]);

    const stats = await storage.getStats();
    // A single per-window row contributes its full value — no baseline pairing.
    expect(stats.blockedRequests).toBe(500);
  });

  it('saveBouncerMetrics ignores duplicates on (server, bouncer, kind, collectedAt)', async () => {
    // CrowdSec LAPI sometimes re-relays the SAME usage-metrics block (same
    // utc_now_timestamp, hence same collectedAt). The unique index +
    // onConflictDoNothing must keep us from double-counting per-window
    // counters in that case.
    const ts = Date.now() - 1000;
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'srvX', bouncerName: 'bX', componentKind: 'remediation', droppedItems: 100, collectedAt: ts }),
    ]);
    // Same key, different value — must be silently dropped.
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'srvX', bouncerName: 'bX', componentKind: 'remediation', droppedItems: 999, collectedAt: ts }),
    ]);
    // Different componentKind on same (server, bouncer, ts) is allowed.
    await storage.saveBouncerMetrics([
      makeRow({ lapiServerName: 'srvX', bouncerName: 'bX', componentKind: 'log_processor', droppedItems: 7, collectedAt: ts }),
    ]);

    const rows = await storage.getBouncerMetrics({});
    expect(rows).toHaveLength(2);
    const remediation = rows.find((r) => r.componentKind === 'remediation');
    // Original 100 wins — second insert was conflict-ignored.
    expect(remediation?.droppedItems).toBe(100);

    // And the homepage stat sees the canonical 100, not 100 + 999.
    const stats = await storage.getStats();
    expect(stats.blockedRequests).toBe(100);
  });

  it('cleanupBouncerMetrics deletes only old rows', async () => {
    const now = Date.now();
    const oldMs = now - 40 * 24 * 60 * 60 * 1000; // 40 days old
    const recentMs = now - 2 * 24 * 60 * 60 * 1000; // 2 days old

    await storage.saveBouncerMetrics([
      makeRow({ collectedAt: oldMs, bouncerName: 'old' }),
      makeRow({ collectedAt: recentMs, bouncerName: 'recent' }),
    ]);

    const deleted = await storage.cleanupBouncerMetrics(30);
    expect(deleted).toBe(1);

    const remaining = await storage.getBouncerMetrics({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].bouncerName).toBe('recent');
  });
});
