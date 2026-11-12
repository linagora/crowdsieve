/**
 * Backend route tests for GET /api/alerts `ip` filter.
 *
 * Range-scoped alerts store their CIDR in `sourceValue`, so the dashboard's
 * alert history must be able to query them by passing the CIDR as `ip`.
 * These tests check that the route accepts a single address or a CIDR,
 * normalizes it, and forwards it to the storage query, while still rejecting
 * invalid values with a 400.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { AlertQuery, AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';

const TEST_API_KEY = 'test-api-key-alerts-ip-filter';

function buildConfig(): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
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
  } as Config;
}

let queries: AlertQuery[];
let app: FastifyInstance;

function buildMockStorage(): AlertStorage {
  const notImplemented = () => {
    throw new Error('not implemented in test');
  };
  return {
    storeAlerts: notImplemented as unknown as AlertStorage['storeAlerts'],
    markAlertsForwarded: notImplemented as unknown as AlertStorage['markAlertsForwarded'],
    markAlertsReplicated: notImplemented as unknown as AlertStorage['markAlertsReplicated'],
    recordUnbanEvent: notImplemented as unknown as AlertStorage['recordUnbanEvent'],
    recordManualBanAuditEvent:
      notImplemented as unknown as AlertStorage['recordManualBanAuditEvent'],
    queryAlerts: async (query) => {
      queries.push(query);
      return [];
    },
    getAlertById: notImplemented as unknown as AlertStorage['getAlertById'],
    hasAlertsNewerThan: notImplemented as unknown as AlertStorage['hasAlertsNewerThan'],
    getStats: notImplemented as unknown as AlertStorage['getStats'],
    getTimeDistributionStats: notImplemented as unknown as AlertStorage['getTimeDistributionStats'],
    getDecisionStats: notImplemented as unknown as AlertStorage['getDecisionStats'],
    cleanup: notImplemented as unknown as AlertStorage['cleanup'],
    saveBouncerMetrics: notImplemented as unknown as AlertStorage['saveBouncerMetrics'],
    getBouncerMetrics: notImplemented as unknown as AlertStorage['getBouncerMetrics'],
    getBouncerNames: notImplemented as unknown as AlertStorage['getBouncerNames'],
    cleanupBouncerMetrics: notImplemented as unknown as AlertStorage['cleanupBouncerMetrics'],
  };
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;

  app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
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
  app.decorate('config', buildConfig());
  app.decorate('storage', buildMockStorage());
  app.decorate('proxyLogger', createLogger({ level: 'silent' }));
  app.decorate('clientValidator', undefined);
  app.decorate('replicationService', undefined as ReplicationService | undefined);

  await app.register(import('../src/proxy/routes/api.js'));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  queries = [];
});

function getAlerts(ip: string) {
  return app.inject({
    method: 'GET',
    url: `/api/alerts?ip=${encodeURIComponent(ip)}`,
    headers: { 'X-API-Key': TEST_API_KEY },
  });
}

describe('GET /api/alerts — ip filter', () => {
  it('accepts a single IPv4 address', async () => {
    const res = await getAlerts('203.0.113.7');

    expect(res.statusCode).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].sourceIp).toBe('203.0.113.7');
  });

  it('accepts an IPv4 CIDR (range-scoped alert)', async () => {
    const res = await getAlerts('198.51.100.128/25');

    expect(res.statusCode).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].sourceIp).toBe('198.51.100.128/25');
  });

  it('accepts an IPv6 CIDR (range-scoped alert)', async () => {
    const res = await getAlerts('2001:db8::/32');

    expect(res.statusCode).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].sourceIp).toBe('2001:db8::/32');
  });

  it('trims surrounding whitespace', async () => {
    const res = await getAlerts('  198.51.100.128/25  ');

    expect(res.statusCode).toBe(200);
    expect(queries[0].sourceIp).toBe('198.51.100.128/25');
  });

  it('rejects a malformed value with a 400', async () => {
    const res = await getAlerts('not-an-ip');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/IP address|CIDR/i) });
    expect(queries).toHaveLength(0);
  });

  it('rejects a CIDR with an out-of-range prefix', async () => {
    const res = await getAlerts('198.51.100.128/33');

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });
});
