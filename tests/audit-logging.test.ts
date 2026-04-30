/**
 * Audit-friendly logging tests
 *
 * Verifies that:
 *   - POST /api/decisions/ban emits a `notice`-level log with `event: manual_ban`
 *     and the actor, scope, target, duration and reason
 *   - DELETE /api/decisions/:id emits a `notice`-level log with
 *     `event: manual_unban` and the actor, scope, target and reason
 *
 * Captures pino output by writing to a destination stream and parsing each
 * NDJSON line. Uses a dedicated Fastify app (created once in beforeAll, like
 * the sibling route tests) decorated with a capturing logger; the `captured`
 * array is reset at the start of each test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';
import { createLogger } from '../src/logging.js';

const TEST_API_KEY = 'test-api-key-audit-logging';

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

function buildMockStorage(): AlertStorage {
  const noop = (() => undefined) as unknown;
  const stub = noop as never;
  return {
    storeAlerts: stub,
    markAlertsForwarded: stub,
    markAlertsReplicated: stub,
    recordUnbanEvent: (async () => 1) as unknown as AlertStorage['recordUnbanEvent'],
    recordManualBanAuditEvent: (async () =>
      1) as unknown as AlertStorage['recordManualBanAuditEvent'],
    queryAlerts: stub,
    getAlertById: stub,
    hasAlertsNewerThan: stub,
    getStats: stub,
    getTimeDistributionStats: stub,
    getDecisionStats: stub,
    cleanup: stub,
  };
}

let app: FastifyInstance;
let originalFetch: typeof fetch;
let captured: Array<Record<string, unknown>>;
let mockFetch: ReturnType<typeof vi.fn>;
const machineTokenJsonResponse = { code: 200, expire: '2099-01-01T00:00:00Z', token: 'mock-token' };

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;

  originalFetch = global.fetch;
  mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/v1/watchers/login')) {
      return new Response(JSON.stringify(machineTokenJsonResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/v1/alerts')) {
      return new Response(JSON.stringify([12345]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/v1/decisions/') && init?.method === 'DELETE') {
      return new Response('{"nbDeleted":1}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mockFetch);

  captured = [];
  // Capturing destination stream: parses each pino NDJSON line into the
  // `captured` array. Level filter is set to `notice` — we expect at least
  // one notice-level entry per audit-worthy action.
  // pino destinations may receive `string | Buffer`; coerce defensively so
  // the capture works across pino/node stream implementations.
  const stream = {
    write(chunk: string | Buffer) {
      const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim();
      if (text.length === 0) return;
      try {
        captured.push(JSON.parse(text));
      } catch {
        // Ignore malformed lines — pino occasionally writes non-JSON during
        // teardown.
      }
    },
  };
  // Use the same level-label formatter as production so log entries carry
  // `level: 'notice'` (string) rather than the numeric value.
  const logger = createLogger(
    {
      level: 'notice',
      formatters: { level: (label) => ({ level: label }) },
    },
    stream
  );

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
  app.decorate('proxyLogger', logger);
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

describe('Audit logging — manual ban', () => {
  it('emits a notice-level entry with actor + audit fields after a successful ban', async () => {
    captured.length = 0;

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
        ip: '203.0.113.7',
        duration: '2h',
        reason: 'audit-log smoke test',
      },
    });
    expect(res.statusCode).toBe(200);

    const noticeEntries = captured.filter((e) => e.level === 'notice');
    expect(noticeEntries.length).toBeGreaterThan(0);
    const banEntry = noticeEntries.find((e) => e.event === 'manual_ban');
    expect(banEntry).toBeDefined();
    expect(banEntry).toMatchObject({
      level: 'notice',
      event: 'manual_ban',
      actor: 'alice@example.com',
      server: 'test-lapi',
      target: '203.0.113.7',
      scope: 'ip',
      duration: '2h',
      reason: 'audit-log smoke test',
    });
  });

  it('emits the notice without actor when X-Crowdsieve-Actor is absent', async () => {
    captured.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      payload: {
        server: 'test-lapi',
        ip: '203.0.113.8',
        duration: '4h',
        reason: 'no actor',
      },
    });
    expect(res.statusCode).toBe(200);

    const banEntry = captured.find((e) => e.level === 'notice' && e.event === 'manual_ban');
    expect(banEntry).toBeDefined();
    // When the header is absent, actor is null; pino serializes that.
    expect(banEntry).toMatchObject({ event: 'manual_ban', actor: null });
  });
});

describe('Audit logging — manual unban', () => {
  it('emits a notice-level entry with actor + audit fields after a successful unban', async () => {
    captured.length = 0;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/4242?server=test-lapi',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-Crowdsieve-Actor': 'bob@example.com',
        'Content-Type': 'application/json',
      },
      payload: {
        ip: '203.0.113.9',
        reason: 'unban smoke test',
      },
    });
    expect(res.statusCode).toBe(200);

    const unbanEntry = captured.find((e) => e.level === 'notice' && e.event === 'manual_unban');
    expect(unbanEntry).toBeDefined();
    expect(unbanEntry).toMatchObject({
      level: 'notice',
      event: 'manual_unban',
      actor: 'bob@example.com',
      server: 'test-lapi',
      decisionId: 4242,
      target: '203.0.113.9',
      scope: 'ip',
      reason: 'unban smoke test',
    });
  });
});
