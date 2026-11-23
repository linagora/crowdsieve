/**
 * Status service (CAPI forwarding counters, LAPI health checks), the
 * GET /api/status route, and the hooks in the signals route and replication.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Config } from '../src/config/index.js';
import type { AlertStorage } from '../src/storage/index.js';
import { FilterEngine } from '../src/filters/index.js';
import { createLogger } from '../src/logging.js';
import { createReplicationService } from '../src/replication/index.js';
import { clearTokenCache } from '../src/auth/machineToken.js';
import {
  CAPI_WINDOW_MS,
  createStatusService,
  sanitizeError,
  urlHost,
  type StatusEvent,
  type StatusService,
} from '../src/status/index.js';

const API_KEY_SECRET = 'bouncer-key-SECRET-123';
const PASSWORD_SECRET = 'machine-password-SECRET-456';
const CAPI_URL = 'https://capi.example.test';
const TEST_API_KEY = 'dashboard-key';

function buildConfig(overrides: { forward?: boolean; servers?: Config['lapi_servers'] } = {}) {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: CAPI_URL,
      timeout_ms: 5000,
      forward_enabled: overrides.forward ?? true,
    },
    lapi_servers: overrides.servers ?? [
      {
        name: 'lapi-a',
        url: 'https://user:urlpass@lapi-a.example.test:8080/base?token=abc',
        api_key: API_KEY_SECRET,
        machine_id: 'crowdsieve',
        password: PASSWORD_SECRET,
        replicate_decisions: true,
      },
      {
        name: 'lapi-b',
        url: 'https://lapi-b.example.test',
        api_key: 'other-key-SECRET',
        replicate_decisions: false,
      },
    ],
    storage: {},
    logging: {},
    filters: { mode: 'block', rules: [] },
    client_validation: { enabled: false },
  } as unknown as Config;
}

const logger = createLogger({ level: 'silent' });

function makeClock(start = Date.UTC(2026, 10, 23, 10, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeService(
  config: Config,
  fetchImpl: typeof fetch,
  clock = makeClock(),
  getMachineToken = vi.fn(async () => 'jwt-token')
) {
  const service = createStatusService(config, logger, {
    now: clock.now,
    fetchImpl,
    getMachineToken: getMachineToken as never,
  });
  return { service, clock, getMachineToken };
}

describe('sanitizeError / urlHost', () => {
  it('strips URL credentials and query strings', () => {
    const msg = sanitizeError(new Error('GET https://u:p@host.test/x?token=abc failed'));
    expect(msg).toBe('GET https://host.test/x failed');
  });

  it('masks configured secrets', () => {
    expect(sanitizeError(new Error('bad key hunter2hunter2'), ['hunter2hunter2'])).toBe(
      'bad key ***'
    );
  });

  it('reports a timeout without internals and truncates long messages', () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    expect(sanitizeError(timeout)).toBe('Request timed out');
    expect(sanitizeError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(201);
  });

  it('includes the network error code of the cause', () => {
    const err = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(sanitizeError(err)).toBe('fetch failed (ECONNREFUSED)');
  });

  it('keeps only the host of a URL', () => {
    expect(urlHost('https://u:p@lapi.test:8080/base?token=abc')).toBe('lapi.test:8080');
    expect(urlHost('not a url')).toBe('');
  });
});

describe('CAPI forwarding counters', () => {
  it('is disabled when forwarding is off', () => {
    const { service } = makeService(buildConfig({ forward: false }), vi.fn() as never);
    const snap = service.getSnapshot();
    expect(snap.capi.enabled).toBe(false);
    expect(snap.capi.state).toBe('disabled');
    expect(snap.ok).toBe(true);
  });

  it('is idle until something was forwarded, then ok', () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    expect(service.getSnapshot().capi.state).toBe('idle');
    service.recordCapiSuccess(3);
    const { capi } = service.getSnapshot();
    expect(capi.state).toBe('ok');
    expect(capi.sent24h).toBe(3);
    expect(capi.lastSuccessAt).not.toBeNull();
  });

  it('reports failing with the last error and clears it on the next success', () => {
    const { service, clock } = makeService(buildConfig(), vi.fn() as never);
    const failedAt = clock.now();
    service.recordCapiFailure(2, new Error('fetch failed'));
    clock.advance(1000);
    service.recordCapiFailure(1, new Error('still down'));

    let snap = service.getSnapshot();
    expect(snap.capi.state).toBe('failing');
    expect(snap.capi.failingSince).toBe(failedAt);
    expect(snap.capi.lastError).toEqual({ at: failedAt + 1000, message: 'still down' });
    expect(snap.capi.failed24h).toBe(3);
    expect(snap.ok).toBe(false);
    expect(snap.problems).toHaveLength(1);
    expect(snap.problems[0]).toMatchObject({ kind: 'capi', since: failedAt });

    service.recordCapiSuccess(1);
    snap = service.getSnapshot();
    expect(snap.capi.state).toBe('ok');
    expect(snap.capi.failingSince).toBeNull();
    expect(snap.ok).toBe(true);
    // The last error stays visible for the operator.
    expect(snap.capi.lastError?.message).toBe('still down');
  });

  it('only counts the last 24 hours', () => {
    const { service, clock } = makeService(buildConfig(), vi.fn() as never);
    service.recordCapiSuccess(10);
    clock.advance(CAPI_WINDOW_MS - 60_000);
    service.recordCapiSuccess(5);
    expect(service.getSnapshot().capi.sent24h).toBe(15);
    clock.advance(2 * 60_000);
    expect(service.getSnapshot().capi.sent24h).toBe(5);
  });

  it('notifies subscribers and survives a throwing listener', () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    const events: StatusEvent[] = [];
    service.onEvent(() => {
      throw new Error('boom');
    });
    const off = service.onEvent((e) => events.push(e));
    service.recordCapiFailure(1, new Error('down'));
    service.recordCapiSuccess(1);
    off();
    service.recordCapiSuccess(1);
    expect(events.map((e) => e.type)).toEqual(['capi_forward_failed', 'capi_forward_succeeded']);
    expect(events[0]).toMatchObject({ count: 1, message: 'down' });
  });
});

describe('LAPI health checks', () => {
  it('uses the heartbeat with the machine JWT, else the bouncer key', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response('{}', { status: 200 });
    });
    const { service, getMachineToken } = makeService(buildConfig(), fetchImpl as never);

    await service.checkLapis();

    expect(getMachineToken).toHaveBeenCalledTimes(1);
    const a = calls.find((c) => c.url.includes('lapi-a'))!;
    expect(a.url).toContain('/v1/heartbeat');
    expect(a.headers.Authorization).toBe('Bearer jwt-token');
    const b = calls.find((c) => c.url.includes('lapi-b'))!;
    expect(b.url).toBe('https://lapi-b.example.test/v1/decisions?ip=127.0.0.1');
    expect(b.headers['X-Api-Key']).toBe('other-key-SECRET');

    const snap = service.getSnapshot();
    expect(snap.lapis.map((l) => l.reachable)).toEqual([true, true]);
    expect(snap.lapis[0]).toMatchObject({
      name: 'lapi-a',
      host: 'lapi-a.example.test:8080',
      manualBanAvailable: true,
      machineAuth: 'ok',
    });
    expect(snap.lapis[1]).toMatchObject({
      manualBanAvailable: false,
      machineAuth: 'not_configured',
    });
    expect(snap.ok).toBe(true);
  });

  it('measures the response time', async () => {
    const clock = makeClock();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('lapi-b')) clock.advance(42);
      return new Response('{}', { status: 200 });
    });
    const { service } = makeService(buildConfig(), fetchImpl as never, clock);
    await service.checkLapis();
    expect(service.getSnapshot().lapis[1].responseTimeMs).toBe(42);
  });

  it('reports an unreachable LAPI with a sanitized error, events and recovery', async () => {
    let down = true;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (down && String(url).includes('lapi-a')) {
        throw new TypeError(`fetch failed ${String(url)} ${API_KEY_SECRET}`, {
          cause: { code: 'ECONNREFUSED' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    const { service, clock } = makeService(buildConfig(), fetchImpl as never);
    const events: StatusEvent[] = [];
    service.onEvent((e) => events.push(e));

    await service.checkLapis();
    let snap = service.getSnapshot();
    const a = snap.lapis[0];
    expect(a.reachable).toBe(false);
    expect(a.error).toContain('ECONNREFUSED');
    expect(a.error).not.toContain(API_KEY_SECRET);
    expect(a.error).not.toContain('urlpass');
    expect(a.error).not.toContain('token=abc');
    expect(snap.ok).toBe(false);
    expect(snap.problems[0]).toMatchObject({ kind: 'lapi', server: 'lapi-a' });

    // A second failing check does not re-emit.
    clock.advance(60_000);
    await service.checkLapis();
    expect(events.filter((e) => e.type === 'lapi_unreachable')).toHaveLength(1);

    down = false;
    clock.advance(60_000);
    await service.checkLapis();
    snap = service.getSnapshot();
    expect(snap.lapis[0].reachable).toBe(true);
    expect(snap.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['lapi_unreachable', 'lapi_recovered']);
  });

  it('treats an HTTP error status as a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const { service } = makeService(buildConfig(), fetchImpl as never);
    await service.checkLapis();
    expect(service.getSnapshot().lapis[1]).toMatchObject({ reachable: false, error: 'HTTP 503' });
  });

  it('falls back to the bouncer key when the machine login fails', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    });
    const { service } = makeService(
      buildConfig(),
      fetchImpl as never,
      makeClock(),
      vi.fn(async () => null)
    );
    await service.checkLapis();
    const a = service.getSnapshot().lapis[0];
    expect(calls.some((u) => u.includes('lapi-a') && u.includes('/v1/decisions'))).toBe(true);
    expect(a.reachable).toBe(true);
    expect(a.machineAuth).toBe('failed');
    expect(a.manualBanAvailable).toBe(false);
  });

  it('is not reported as a problem before the first check', () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    const snap = service.getSnapshot();
    expect(snap.lapis[0].reachable).toBeNull();
    expect(snap.ok).toBe(true);
  });

  it('records replication errors per server', () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    const events: StatusEvent[] = [];
    service.onEvent((e) => events.push(e));
    service.recordReplicationFailure('lapi-a', new Error(`failed with ${PASSWORD_SECRET}`));
    let a = service.getSnapshot().lapis[0];
    expect(a.replication.enabled).toBe(true);
    expect(a.replication.lastError?.message).toBe('failed with ***');
    expect(events[0]).toMatchObject({ type: 'replication_failed', server: 'lapi-a' });
    service.recordReplicationSuccess('lapi-a');
    a = service.getSnapshot().lapis[0];
    expect(a.replication.lastSuccessAt).not.toBeNull();
    // Unknown servers are ignored.
    expect(() => service.recordReplicationSuccess('ghost')).not.toThrow();
  });

  it('never leaks secrets in the snapshot', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`boom ${API_KEY_SECRET} ${PASSWORD_SECRET}`);
    });
    const { service } = makeService(buildConfig(), fetchImpl as never);
    await service.checkLapis();
    service.recordCapiFailure(1, new Error(`capi ${API_KEY_SECRET}`));
    service.recordReplicationFailure('lapi-a', new Error(PASSWORD_SECRET));
    const json = JSON.stringify(service.getSnapshot());
    for (const secret of [API_KEY_SECRET, PASSWORD_SECRET, 'urlpass', 'token=abc', 'other-key']) {
      expect(json).not.toContain(secret);
    }
  });
});

describe('periodic check lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks at start and every interval, and stops on stop()', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const service = createStatusService(buildConfig({ servers: [oneServer()] }), logger, {
      fetchImpl: fetchImpl as never,
      checkIntervalMs: 60_000,
    });

    service.start();
    service.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not keep the process alive and bounds the request timeout', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const config = buildConfig({ servers: [oneServer()] });
    config.proxy.timeout_ms = 120_000;
    const service = createStatusService(config, logger, { fetchImpl: fetchImpl as never });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
    // unref() is applied to the timer: the pending timer count is cleared by stop().
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a check while the previous one is still running', async () => {
    let release: () => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response('{}', { status: 200 }));
        })
    );
    const service = createStatusService(buildConfig({ servers: [oneServer()] }), logger, {
      fetchImpl: fetchImpl as never,
    });
    const first = service.checkLapis();
    await service.checkLapis();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

function oneServer(): NonNullable<Config['lapi_servers']> {
  return [
    {
      name: 'solo',
      url: 'https://solo.example.test',
      api_key: 'solo-key',
      replicate_decisions: false,
    },
  ] as Config['lapi_servers'];
}

describe('GET /api/status', () => {
  let app: FastifyInstance;

  async function build(service?: StatusService) {
    process.env.DASHBOARD_API_KEY = TEST_API_KEY;
    const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    instance.decorate('config', buildConfig());
    instance.decorate('storage', {} as AlertStorage);
    instance.decorate('proxyLogger', logger);
    instance.decorate('clientValidator', undefined);
    instance.decorate('replicationService', undefined);
    instance.decorate('statusService', service);
    await instance.register(import('../src/proxy/routes/api.js'));
    await instance.ready();
    return instance;
  }

  afterEach(async () => {
    await app?.close();
  });

  it('requires the API key', async () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    app = await build(service);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the snapshot without any secret', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { service } = makeService(buildConfig(), fetchImpl as never);
    await service.checkLapis();
    service.recordCapiFailure(1, new Error('down'));
    app = await build(service);

    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { 'X-API-Key': TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.capi.state).toBe('failing');
    expect(body.lapis).toHaveLength(2);
    expect(typeof body.generatedAt).toBe('number');
    for (const secret of [API_KEY_SECRET, PASSWORD_SECRET, 'urlpass', 'token=abc']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('answers 503 when the service is not wired', async () => {
    app = await build(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { 'X-API-Key': TEST_API_KEY },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('signals route and replication hooks', () => {
  let app: FastifyInstance;
  let capiResponse: () => Response | Promise<Response>;

  beforeEach(() => {
    clearTokenCache();
    capiResponse = () => new Response('{}', { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith(CAPI_URL)) return capiResponse();
        if (url.endsWith('/v1/watchers/login')) {
          return new Response(
            JSON.stringify({ token: 't', expire: new Date(Date.now() + 3600_000).toISOString() }),
            { status: 200 }
          );
        }
        if (url.endsWith('/v1/alerts')) return new Response('["1"]', { status: 500 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });

  async function build(service: StatusService, config = buildConfig()) {
    const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    instance.decorate('config', config);
    instance.decorate('filterEngine', new FilterEngine('block', []));
    instance.decorate('storage', {
      storeAlerts: vi.fn(async () => ({ replicableIndices: [] })),
      markAlertsForwarded: vi.fn(async () => undefined),
    } as unknown as AlertStorage);
    instance.decorate('proxyLogger', logger);
    instance.decorate('clientValidator', undefined);
    instance.decorate('replicationService', undefined);
    instance.decorate('statusService', service);
    await instance.register(import('../src/proxy/routes/signals.js'));
    await instance.ready();
    return instance;
  }

  const alerts = [
    { scenario: 'a/b', message: 'm' },
    { scenario: 'c/d', message: 'n' },
  ];

  it('counts forwarded alerts on success', async () => {
    const { service } = makeService(buildConfig(), vi.fn() as never);
    app = await build(service);
    const res = await app.inject({ method: 'POST', url: '/v3/signals', payload: alerts });
    expect(res.statusCode).toBe(200);
    const { capi } = service.getSnapshot();
    expect(capi.state).toBe('ok');
    expect(capi.sent24h).toBe(2);
  });

  it('records a failure when CAPI is unreachable', async () => {
    capiResponse = () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    const { service } = makeService(buildConfig(), vi.fn() as never);
    const events: StatusEvent[] = [];
    service.onEvent((e) => events.push(e));
    app = await build(service);

    const res = await app.inject({ method: 'POST', url: '/v3/signals', payload: alerts });

    expect(res.statusCode).toBe(502);
    const { capi } = service.getSnapshot();
    expect(capi.state).toBe('failing');
    expect(capi.lastError?.message).toContain('ECONNREFUSED');
    expect(capi.failed24h).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['capi_forward_failed']);
  });

  it('records a failure when CAPI rejects the credentials', async () => {
    capiResponse = () => new Response('unauthorized', { status: 401 });
    const { service } = makeService(buildConfig(), vi.fn() as never);
    app = await build(service);

    const res = await app.inject({ method: 'POST', url: '/v3/signals', payload: alerts });

    expect(res.statusCode).toBe(401);
    expect(service.getSnapshot().capi.lastError?.message).toContain('401');
  });

  it('does not count anything when forwarding is disabled', async () => {
    const { service } = makeService(buildConfig({ forward: false }), vi.fn() as never);
    app = await build(service, buildConfig({ forward: false }));
    await app.inject({ method: 'POST', url: '/v3/signals', payload: alerts });
    const { capi } = service.getSnapshot();
    expect(capi.state).toBe('disabled');
    expect(capi.sent24h).toBe(0);
  });

  it('still works without a status service', async () => {
    const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    instance.decorate('config', buildConfig());
    instance.decorate('filterEngine', new FilterEngine('block', []));
    instance.decorate('storage', {
      storeAlerts: vi.fn(async () => ({ replicableIndices: [] })),
      markAlertsForwarded: vi.fn(async () => undefined),
    } as unknown as AlertStorage);
    instance.decorate('proxyLogger', logger);
    instance.decorate('clientValidator', undefined);
    instance.decorate('replicationService', undefined);
    await instance.register(import('../src/proxy/routes/signals.js'));
    await instance.ready();
    app = instance;
    const res = await app.inject({ method: 'POST', url: '/v3/signals', payload: alerts });
    expect(res.statusCode).toBe(200);
  });

  it('feeds replication outcomes into the status', async () => {
    const base = buildConfig();
    const config = buildConfig({
      servers: [
        base.lapi_servers[0],
        {
          name: 'lapi-src',
          url: 'https://lapi-src.example.test',
          api_key: 'src-key',
          replicate_decisions: false,
          source_machine_ids: ['trusted'],
        },
      ] as Config['lapi_servers'],
    });
    const { service } = makeService(config, vi.fn() as never);
    const replication = createReplicationService(config, logger, service);

    await replication.replicateDecisions(
      [
        {
          scenario: 'a/b',
          message: 'm',
          decisions: [
            {
              scenario: 'a/b',
              type: 'ban',
              value: '203.0.113.9',
              origin: 'crowdsec',
              duration: '4h',
              scope: 'ip',
            },
          ],
        } as never,
      ],
      { authenticated: true, machineId: 'trusted' }
    );

    const a = service.getSnapshot().lapis[0];
    expect(a.replication.lastError?.message).toContain('500');
  });
});
