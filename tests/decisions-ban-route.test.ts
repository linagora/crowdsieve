/**
 * Backend route tests for POST /api/decisions/ban
 *
 * Verifies:
 *   - On a successful upstream LAPI ban, the route calls
 *     storage.recordManualBanAuditEvent with the actor parsed from
 *     X-Crowdsieve-Actor and the LAPI-returned decision id (when present)
 *   - Missing actor header is fine: the call still happens with actor=null
 *   - Failed LAPI bans do not record an audit event
 *   - Whitespace-only reasons are rejected with 400 (no audit row)
 *   - Invalid IPs are rejected with 400 (no audit row)
 *
 * The hook in api.ts requires X-API-Key matching DASHBOARD_API_KEY; we set
 * that env var before registering the plugin. Mirrors the structure of
 * decisions-delete-route.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';

const TEST_API_KEY = 'test-api-key-decisions-ban';

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

interface RecordManualBanAuditCall {
  ip: string;
  scope: 'ip' | 'range';
  comment: string;
  server: string;
  duration: string;
  decisionId?: number;
  actor?: string | null;
}

let recordManualBanAuditCalls: RecordManualBanAuditCall[];
let app: FastifyInstance;
let originalFetch: typeof fetch;
let mockFetch: ReturnType<typeof vi.fn>;
const machineTokenJsonResponse = { code: 200, expire: '2099-01-01T00:00:00Z', token: 'mock-token' };

function buildMockStorage(): AlertStorage {
  // Only `recordManualBanAuditEvent` is exercised by the POST handler. The
  // other methods are stubbed to satisfy the AlertStorage interface; they're
  // not invoked by this test path.
  const notImplemented = () => {
    throw new Error('not implemented in test');
  };
  return {
    storeAlerts: notImplemented as unknown as AlertStorage['storeAlerts'],
    markAlertsForwarded: notImplemented as unknown as AlertStorage['markAlertsForwarded'],
    markAlertsReplicated: notImplemented as unknown as AlertStorage['markAlertsReplicated'],
    recordUnbanEvent: notImplemented as unknown as AlertStorage['recordUnbanEvent'],
    recordManualBanAuditEvent: async (input) => {
      recordManualBanAuditCalls.push({
        ip: input.ip,
        scope: input.scope,
        comment: input.comment,
        server: input.server,
        duration: input.duration,
        decisionId: input.decisionId,
        actor: input.actor ?? null,
      });
      return 1;
    },
    queryAlerts: notImplemented as unknown as AlertStorage['queryAlerts'],
    getAlertById: notImplemented as unknown as AlertStorage['getAlertById'],
    hasAlertsNewerThan: notImplemented as unknown as AlertStorage['hasAlertsNewerThan'],
    getStats: notImplemented as unknown as AlertStorage['getStats'],
    getTimeDistributionStats:
      notImplemented as unknown as AlertStorage['getTimeDistributionStats'],
    getDecisionStats: notImplemented as unknown as AlertStorage['getDecisionStats'],
    cleanup: notImplemented as unknown as AlertStorage['cleanup'],
  };
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;

  // Mock global fetch to intercept both /v1/watchers/login (machine token) and
  // /v1/alerts (the actual ban). Matched by URL substring.
  originalFetch = global.fetch;
  mockFetch = vi.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/v1/watchers/login')) {
      return new Response(JSON.stringify(machineTokenJsonResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/v1/alerts')) {
      // LAPI returns an array of decision ids on /v1/alerts.
      return new Response(JSON.stringify([12345]), {
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
  recordManualBanAuditCalls = [];
});

describe('POST /api/decisions/ban — schema and validation', () => {
  it('rejects request without a body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(recordManualBanAuditCalls).toHaveLength(0);
  });

  it('rejects request with whitespace-only reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.10',
        duration: '4h',
        reason: '   ',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/blank|whitespace/i);
    expect(recordManualBanAuditCalls).toHaveLength(0);
  });

  it('rejects request with an invalid IP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: 'not-an-ip',
        duration: '4h',
        reason: 'Spam',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/IP address|CIDR/i);
    expect(recordManualBanAuditCalls).toHaveLength(0);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.10',
        duration: '4h',
        reason: 'Spam',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(recordManualBanAuditCalls).toHaveLength(0);
  });
});

describe('POST /api/decisions/ban — actor propagation', () => {
  it('records a manual ban audit event with actor parsed from X-Crowdsieve-Actor and decisionId from LAPI', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'alice@example.com',
        'Content-Type': 'application/json',
      },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.42',
        duration: '4h',
        reason: 'Spam from this IP',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordManualBanAuditCalls).toHaveLength(1);
    expect(recordManualBanAuditCalls[0]).toMatchObject({
      ip: '203.0.113.42',
      scope: 'ip',
      comment: 'Spam from this IP',
      server: 'test-lapi',
      duration: '4h',
      decisionId: 12345,
      actor: 'alice@example.com',
    });
  });

  it('records actor=null when X-Crowdsieve-Actor is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'Content-Type': 'application/json',
      },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.43',
        duration: '4h',
        reason: 'cleanup',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordManualBanAuditCalls).toHaveLength(1);
    expect(recordManualBanAuditCalls[0].actor).toBeNull();
  });

  it('records audit row even when LAPI returns an unparseable decision id', async () => {
    // Override the LAPI /v1/alerts response with a non-array body so the
    // decisionId extraction falls back to undefined. The audit row should
    // still be created. The machine token is cached from previous tests,
    // so only the /v1/alerts fetch happens here — queue a single override.
    mockFetch.mockImplementationOnce(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/v1/watchers/login')) {
        return new Response(JSON.stringify(machineTokenJsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/v1/alerts')) {
        return new Response(JSON.stringify({ unexpected: 'shape' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'bob',
        'Content-Type': 'application/json',
      },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.44',
        duration: '1h',
        reason: 'no id',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordManualBanAuditCalls).toHaveLength(1);
    expect(recordManualBanAuditCalls[0].actor).toBe('bob');
    expect(recordManualBanAuditCalls[0].decisionId).toBeUndefined();
  });

  it('does not record an audit event when LAPI ban fails', async () => {
    // Override the LAPI /v1/alerts response with a 500 from upstream. The
    // route handler maps that to 500 and must NOT call recordManualBanAuditEvent.
    // Machine token is cached, so only the alerts fetch happens.
    mockFetch.mockImplementationOnce(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/v1/watchers/login')) {
        return new Response(JSON.stringify(machineTokenJsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/v1/alerts')) {
        return new Response('boom', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'bob',
        'Content-Type': 'application/json',
      },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.45',
        duration: '4h',
        reason: 'should not record',
      },
    });

    expect(res.statusCode).toBe(500);
    expect(recordManualBanAuditCalls).toHaveLength(0);
  });
});

describe('POST /api/decisions/ban — LAPI alert payload shape', () => {
  // Helper: pull the JSON body sent to /v1/alerts from the most recent fetch
  // call. The handler stringifies the payload, so we parse it back.
  function lastAlertPayload(): unknown {
    for (let i = mockFetch.mock.calls.length - 1; i >= 0; i--) {
      const [url, init] = mockFetch.mock.calls[i] as [string | URL, RequestInit?];
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/v1/alerts') && init?.body && typeof init.body === 'string') {
        return JSON.parse(init.body);
      }
    }
    throw new Error('no /v1/alerts fetch captured');
  }

  it('sets source.ip (and events[].source.ip) when scope=ip', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: '192.168.23.45',
        duration: '4h',
        reason: 'internal-ips test',
      },
    });
    expect(res.statusCode).toBe(200);

    const body = lastAlertPayload() as Array<{
      source: { scope: string; value: string; ip?: string; range?: string };
      events: Array<{ source: { scope: string; value: string; ip?: string; range?: string } }>;
      decisions: Array<{ scope: string; value: string }>;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].source).toMatchObject({
      scope: 'ip',
      value: '192.168.23.45',
      ip: '192.168.23.45',
    });
    expect(body[0].source.range).toBeUndefined();
    expect(body[0].events[0].source).toMatchObject({
      scope: 'ip',
      value: '192.168.23.45',
      ip: '192.168.23.45',
    });
    expect(body[0].decisions[0]).toMatchObject({ scope: 'ip', value: '192.168.23.45' });
  });

  it('sets source.range (and events[].source.range) when scope=range', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: '10.0.0.0/24',
        duration: '4h',
        reason: 'cidr test',
      },
    });
    expect(res.statusCode).toBe(200);

    const body = lastAlertPayload() as Array<{
      source: { scope: string; value: string; ip?: string; range?: string };
      events: Array<{ source: { scope: string; value: string; ip?: string; range?: string } }>;
      decisions: Array<{ scope: string; value: string }>;
    }>;
    expect(body[0].source).toMatchObject({
      scope: 'range',
      value: '10.0.0.0/24',
      range: '10.0.0.0/24',
    });
    expect(body[0].source.ip).toBeUndefined();
    expect(body[0].events[0].source).toMatchObject({
      scope: 'range',
      value: '10.0.0.0/24',
      range: '10.0.0.0/24',
    });
    expect(body[0].decisions[0]).toMatchObject({ scope: 'range', value: '10.0.0.0/24' });
  });
});
