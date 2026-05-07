/**
 * Tests for the bouncer usage-metrics collector and storage round-trip.
 *
 * Covers:
 * - collector parses a typical /v1/usage-metrics payload and produces rows
 * - servers without `api_key` are skipped
 * - per-server HTTP errors are logged and the loop continues
 * - storage round-trip (saveBouncerMetrics + getBouncerMetrics with filters)
 * - cleanupBouncerMetrics deletes only old rows
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import {
  createStorage,
  type AlertStorage,
  type NewBouncerMetric,
} from '../src/storage/index.js';
import { createMetricsCollector } from '../src/metrics/collector.js';
import type { Config, LapiServer } from '../src/config/index.js';
import type { BaseLogger } from 'pino';

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
  `);
}

vi.mock('../src/db/index.js', () => ({
  getDatabaseContext: () => {
    const db = drizzle(sqlite, { schema });
    return { db, schema, isPostgres: false };
  },
}));

function createMockLogger(): BaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as BaseLogger;
}

function createMockConfig(): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
      timeout_ms: 5000,
      forward_enabled: true,
    },
    lapi_servers: [],
    storage: { type: 'sqlite', path: ':memory:', retention_days: 30 },
    logging: { level: 'info', format: 'json' },
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
    bouncer_metrics: {
      enabled: true,
      interval_seconds: 300,
      retention_days: 30,
      request_timeout_ms: 5000,
    },
  };
}

function makeServer(name: string, apiKey?: string): LapiServer {
  return {
    name,
    url: `http://${name}.test:8080`,
    api_key: apiKey ?? 'bouncer-key',
    replicate_decisions: false,
  };
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
        metrics: [{ name: 'processed', value: 999, labels: {} }],
      },
    ],
  };
}

describe('Bouncer metrics collector', () => {
  let storage: AlertStorage;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('parses a typical /v1/usage-metrics payload into rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeUsageMetricsPayload(),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const config = createMockConfig();
    const collector = createMetricsCollector({
      config,
      storage,
      logger: createMockLogger(),
      lapiServers: [makeServer('lapi-a')],
    });

    await collector.runOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('http://lapi-a.test:8080/v1/usage-metrics');
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('bouncer-key');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^crowdsieve\//);

    const rows = await storage.getBouncerMetrics({});
    expect(rows).toHaveLength(2);

    const remediation = rows.find((r) => r.componentKind === 'remediation');
    const logProc = rows.find((r) => r.componentKind === 'log_processor');
    expect(remediation).toBeDefined();
    expect(logProc).toBeDefined();

    expect(remediation?.bouncerName).toBe('firewall-bouncer-1');
    expect(remediation?.bouncerType).toBe('firewall-bouncer');
    expect(remediation?.activeDecisions).toBe(50); // 42 + 8 summed
    expect(remediation?.processedItems).toBe(500);
    expect(remediation?.droppedItems).toBe(100);
    expect(remediation?.bytesProcessed).toBe(1024);
    // metricsJson keeps the verbatim items array, including the unknown metric
    const parsed = JSON.parse(remediation!.metricsJson) as Array<{ name: string }>;
    expect(parsed.some((m) => m.name === 'unknown_metric')).toBe(true);

    expect(logProc?.bouncerName).toBe('lp-1');
    expect(logProc?.processedItems).toBe(999);
    expect(logProc?.activeDecisions).toBe(0);
  });

  it('skips a server with no api_key', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const config = createMockConfig();
    const noKeyServer: LapiServer = {
      name: 'no-key',
      url: 'http://no-key.test:8080',
      api_key: '', // empty triggers the skip path
      replicate_decisions: false,
    };

    const collector = createMetricsCollector({
      config,
      storage,
      logger: createMockLogger(),
      lapiServers: [noKeyServer],
    });

    await collector.runOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await storage.getBouncerMetrics({});
    expect(rows).toHaveLength(0);
  });

  it('logs HTTP errors and continues', async () => {
    const logger = createMockLogger();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'boom',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeUsageMetricsPayload(),
        text: async () => '',
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const collector = createMetricsCollector({
      config: createMockConfig(),
      storage,
      logger,
      lapiServers: [makeServer('broken'), makeServer('ok')],
    });

    await collector.runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();

    // Only the second server produced rows.
    const rows = await storage.getBouncerMetrics({});
    expect(rows.every((r) => r.lapiServerName === 'ok')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('handles network errors per-server without throwing', async () => {
    const logger = createMockLogger();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeUsageMetricsPayload(),
        text: async () => '',
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const collector = createMetricsCollector({
      config: createMockConfig(),
      storage,
      logger,
      lapiServers: [makeServer('down'), makeServer('up')],
    });

    await expect(collector.runOnce()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();

    const rows = await storage.getBouncerMetrics({});
    expect(rows.every((r) => r.lapiServerName === 'up')).toBe(true);
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
      metricsJson: '[]',
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

  it('getStats blockedRequests sums droppedItems from latest snapshot per bouncer', async () => {
    const t1 = Date.now() - 10000;
    const t2 = Date.now() - 1000;
    await storage.saveBouncerMetrics([
      // Two snapshots for (A, fw): older=100, newer=250 → expect 250
      makeRow({ lapiServerName: 'A', bouncerName: 'fw', componentKind: 'remediation', droppedItems: 100, collectedAt: t1 }),
      makeRow({ lapiServerName: 'A', bouncerName: 'fw', componentKind: 'remediation', droppedItems: 250, collectedAt: t2 }),
      // Single snapshot for (A, nginx): 40
      makeRow({ lapiServerName: 'A', bouncerName: 'nginx', componentKind: 'remediation', droppedItems: 40, collectedAt: t1 }),
      // Wrong kind — must be excluded
      makeRow({ lapiServerName: 'A', bouncerName: 'fw', componentKind: 'log_processor', droppedItems: 999, collectedAt: t2 }),
    ]);

    const stats = await storage.getStats();
    expect(stats.blockedRequests).toBe(290); // 250 (latest fw) + 40 (only nginx)
    // Sanity: other fields still exist
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.filtered).toBe('number');
    expect(typeof stats.forwarded).toBe('number');
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
