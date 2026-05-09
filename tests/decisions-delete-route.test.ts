/**
 * Backend route tests for DELETE /api/decisions/:id
 *
 * Verifies:
 *   - Schema rejects requests without a `reason` body field
 *   - Whitespace-only reasons are rejected with 400
 *   - Invalid IPs are rejected with 400
 *   - On a successful upstream LAPI delete, the route calls
 *     storage.recordUnbanEvent with the actor parsed from X-Crowdsieve-Actor
 *   - Missing actor header is fine: the call still happens with actor=null
 *
 * The hook in api.ts requires X-API-Key matching DASHBOARD_API_KEY; we set
 * that env var before registering the plugin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';

const TEST_API_KEY = 'test-api-key-decisions-delete';

// Minimal mock LAPI server config — exercise the "machine creds present"
// happy path so the route reaches the LAPI fetch we mock below.
function buildConfig(): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
      timeout_ms: 5000,
      forward_enabled: true,
    },
    lapi_servers: [
      {
        name: 'test-lapi',
        url: 'http://lapi.test:8080',
        api_key: 'lapi-bouncer-key',
        machine_id: 'test-machine',
        password: 'test-password',
        replicate_decisions: false,
      },
    ],
    storage: {
      type: 'sqlite',
      path: ':memory:',
      retention_days: 30,
    },
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

interface RecordUnbanCall {
  ip: string;
  scope: 'ip' | 'range';
  comment: string;
  server: string;
  decisionId: number;
  actor?: string | null;
}

let recordUnbanCalls: RecordUnbanCall[];
let app: FastifyInstance;
let originalFetch: typeof fetch;
let mockFetch: ReturnType<typeof vi.fn>;
const machineTokenJsonResponse = { code: 200, expire: '2099-01-01T00:00:00Z', token: 'mock-token' };

function buildMockStorage(): AlertStorage {
  // Only `recordUnbanEvent` is actually exercised by the DELETE handler. The
  // other methods are stubbed to satisfy the AlertStorage interface; they're
  // not invoked by this test path.
  const notImplemented = () => {
    throw new Error('not implemented in test');
  };
  return {
    storeAlerts: notImplemented as unknown as AlertStorage['storeAlerts'],
    markAlertsForwarded: notImplemented as unknown as AlertStorage['markAlertsForwarded'],
    markAlertsReplicated: notImplemented as unknown as AlertStorage['markAlertsReplicated'],
    recordUnbanEvent: async (input) => {
      recordUnbanCalls.push({
        ip: input.ip,
        scope: input.scope,
        comment: input.comment,
        server: input.server,
        decisionId: input.decisionId,
        actor: input.actor ?? null,
      });
      return 1;
    },
    recordManualBanAuditEvent:
      notImplemented as unknown as AlertStorage['recordManualBanAuditEvent'],
    queryAlerts: notImplemented as unknown as AlertStorage['queryAlerts'],
    getAlertById: notImplemented as unknown as AlertStorage['getAlertById'],
    hasAlertsNewerThan: notImplemented as unknown as AlertStorage['hasAlertsNewerThan'],
    getStats: notImplemented as unknown as AlertStorage['getStats'],
    getTimeDistributionStats:
      notImplemented as unknown as AlertStorage['getTimeDistributionStats'],
    getDecisionStats: notImplemented as unknown as AlertStorage['getDecisionStats'],
    cleanup: notImplemented as unknown as AlertStorage['cleanup'],
    saveBouncerMetrics: notImplemented as unknown as AlertStorage['saveBouncerMetrics'],
    getBouncerMetrics: notImplemented as unknown as AlertStorage['getBouncerMetrics'],
    getBouncerNames: notImplemented as unknown as AlertStorage['getBouncerNames'],
    cleanupBouncerMetrics:
      notImplemented as unknown as AlertStorage['cleanupBouncerMetrics'],
  };
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;

  // Mock global fetch to intercept both /v1/watchers/login (machine token) and
  // /v1/decisions/:id (the actual delete). Matched by URL substring so we
  // don't care about query/headers on this side.
  originalFetch = global.fetch;
  mockFetch = vi.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/v1/watchers/login')) {
      return new Response(JSON.stringify(machineTokenJsonResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/v1/decisions/')) {
      // Default success — overridden per-test where needed via mockFetch.mockImplementationOnce.
      return new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mockFetch);

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
  vi.unstubAllGlobals();
  global.fetch = originalFetch;
});

beforeEach(() => {
  recordUnbanCalls = [];
});

describe('DELETE /api/decisions/:id — schema and validation', () => {
  it('rejects request without a body (no reason)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/123?server=test-lapi',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(recordUnbanCalls).toHaveLength(0);
  });

  it('rejects request with whitespace-only reason', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/123?server=test-lapi',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: { reason: '   ', ip: '203.0.113.10' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/blank|whitespace/i);
    expect(recordUnbanCalls).toHaveLength(0);
  });

  it('rejects request with an invalid IP', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/123?server=test-lapi',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: { reason: 'False positive', ip: 'not-an-ip' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/IP address|CIDR/i);
    expect(recordUnbanCalls).toHaveLength(0);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/123?server=test-lapi',
      headers: { 'Content-Type': 'application/json' },
      payload: { reason: 'False positive', ip: '203.0.113.11' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/decisions/:id — actor propagation', () => {
  it('records an unban event with actor parsed from X-Crowdsieve-Actor', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/4242?server=test-lapi',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'alice@example.com',
        'Content-Type': 'application/json',
      },
      payload: { reason: 'False positive — internal scanner', ip: '203.0.113.12' },
    });

    expect(res.statusCode).toBe(200);
    expect(recordUnbanCalls).toHaveLength(1);
    expect(recordUnbanCalls[0]).toMatchObject({
      ip: '203.0.113.12',
      scope: 'ip',
      comment: 'False positive — internal scanner',
      server: 'test-lapi',
      decisionId: 4242,
      actor: 'alice@example.com',
    });
  });

  it('records actor=null when X-Crowdsieve-Actor is missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/4243?server=test-lapi',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'Content-Type': 'application/json',
      },
      payload: { reason: 'cleanup', ip: '203.0.113.13' },
    });

    expect(res.statusCode).toBe(200);
    expect(recordUnbanCalls).toHaveLength(1);
    expect(recordUnbanCalls[0].actor).toBeNull();
  });

  it('does not record an unban event when LAPI delete fails', async () => {
    // Override only this fetch with a 404 from LAPI
    mockFetch.mockImplementationOnce(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/v1/watchers/login')) {
        return new Response(JSON.stringify(machineTokenJsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    // The DELETE call goes after the login call, so we need to override
    // both. mockImplementationOnce queues by call order; queue the LAPI
    // delete failure too.
    mockFetch.mockImplementationOnce(async () => {
      return new Response('not found', { status: 404 });
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/9999?server=test-lapi',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'bob',
        'Content-Type': 'application/json',
      },
      payload: { reason: 'should not record', ip: '203.0.113.14' },
    });

    expect(res.statusCode).toBe(404);
    expect(recordUnbanCalls).toHaveLength(0);
  });
});
