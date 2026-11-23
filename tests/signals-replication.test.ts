/**
 * Route tests for POST /v2/signals and /v3/signals decision replication
 * (GHSA-8gp7-jp8p-g9xr).
 *
 * Decisions received through signals must only be replicated to the LAPIs
 * when the sender was authenticated against CAPI (a real 2xx, not a
 * fail-open) and the machine id of its JWT (not of the body) is listed in a
 * `lapi_servers[].source_machine_ids`.
 *
 * These tests wire the real signals route, ClientValidator (with an in-memory
 * persistent cache) and ReplicationService, and mock `fetch` for both CAPI and
 * the LAPIs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { Config } from '../src/config/index.js';
import type { AlertStorage } from '../src/storage/index.js';
import { FilterEngine } from '../src/filters/index.js';
import { ClientValidator } from '../src/validation/index.js';
import { createReplicationService } from '../src/replication/index.js';
import { clearTokenCache } from '../src/auth/machineToken.js';

vi.mock('../src/validation/cache.js', () => {
  const entries = new Map<string, { tokenHash: string; expiresAt: Date }>();
  return {
    ValidationCache: class {
      async lookup(tokenHash: string) {
        return entries.get(tokenHash) ?? null;
      }
      async store(tokenHash: string, ttlSeconds: number) {
        entries.set(tokenHash, { tokenHash, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
      }
      async cleanupExpired() {
        return 0;
      }
    },
  };
});

const CAPI_URL = 'https://capi.example.test';
const TRUSTED_CAPI_MACHINE = 'capi-login-of-lapi1';

function makeJwt(payload: Record<string, unknown>): string {
  const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(payload)}.signature`;
}

function buildConfig(clientValidationEnabled: boolean): Config {
  return {
    proxy: { listen_port: 8080, capi_url: CAPI_URL, timeout_ms: 5000, forward_enabled: false },
    lapi_servers: [
      {
        name: 'lapi1',
        url: 'https://lapi1.example.test',
        api_key: 'k1',
        machine_id: 'crowdsieve',
        password: 'p1',
        replicate_decisions: true,
        source_machine_ids: [TRUSTED_CAPI_MACHINE],
      },
      {
        name: 'lapi2',
        url: 'https://lapi2.example.test',
        api_key: 'k2',
        machine_id: 'crowdsieve',
        password: 'p2',
        replicate_decisions: true,
        source_machine_ids: ['capi-login-of-lapi2'],
      },
    ],
    storage: { type: 'sqlite', path: ':memory:', retention_days: 30 },
    logging: { level: 'info', format: 'json' },
    filters: { mode: 'block', rules: [] },
    client_validation: {
      enabled: clientValidationEnabled,
      cache_ttl_seconds: 604800,
      cache_ttl_error_seconds: 300,
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
  } as Config;
}

function signal(value: string, machineId = 'agent-1') {
  return {
    machine_id: machineId,
    scenario: 'crowdsecurity/ssh-bf',
    scenario_hash: 'h',
    scenario_version: '1.0',
    message: 'm',
    events_count: 1,
    start_at: '2026-01-01T00:00:00Z',
    stop_at: '2026-01-01T00:00:01Z',
    capacity: 1,
    leakspeed: '1s',
    simulated: false,
    events: [],
    source: { scope: 'Ip', value: '192.0.2.1', ip: '192.0.2.1' },
    decisions: [
      {
        origin: 'crowdsec',
        type: 'ban',
        scope: value.includes('/') ? 'Range' : 'Ip',
        value,
        duration: '4h',
        scenario: 'crowdsecurity/ssh-bf',
      },
    ],
  };
}

let app: FastifyInstance;
let markAlertsReplicated: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let capiStatus: number;

function lapiAlertPosts(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.endsWith('/v1/alerts'));
}

async function buildApp(clientValidationEnabled: boolean): Promise<FastifyInstance> {
  const config = buildConfig(clientValidationEnabled);
  const logger = createLogger({ level: 'silent' });
  const storage = {
    storeAlerts: vi.fn(async (alerts: unknown[]) => ({
      replicableIndices: alerts.map((_, i) => i),
    })),
    markAlertsReplicated,
    markAlertsForwarded: vi.fn(async () => undefined),
  } as unknown as AlertStorage;

  const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  instance.decorate('config', config);
  instance.decorate('filterEngine', new FilterEngine('block', []));
  instance.decorate('storage', storage);
  instance.decorate('proxyLogger', logger);
  instance.decorate(
    'clientValidator',
    new ClientValidator(
      {
        enabled: clientValidationEnabled,
        cacheTtlSeconds: 604800,
        cacheTtlErrorSeconds: 300,
        validationTimeoutMs: 5000,
        maxMemoryEntries: 1000,
        failClosed: false,
      },
      CAPI_URL,
      logger
    )
  );
  instance.decorate('replicationService', createReplicationService(config, logger));
  await instance.register(import('../src/proxy/routes/signals.js'));
  await instance.ready();
  return instance;
}

async function post(body: unknown, authorization?: string, version: 'v2' | 'v3' = 'v2') {
  const res = await app.inject({
    method: 'POST',
    url: `/${version}/signals`,
    headers: authorization ? { authorization } : {},
    payload: body as object,
  });
  // Replication runs in a setImmediate callback after the response; every
  // fetch is mocked and resolves at once, so a short delay lets it settle.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return res;
}

describe('signals route decision replication', () => {
  beforeEach(() => {
    clearTokenCache();
    capiStatus = 200;
    markAlertsReplicated = vi.fn(async () => undefined);
    fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === `${CAPI_URL}/v3/signals`) {
        return new Response('{}', { status: capiStatus });
      }
      if (url.endsWith('/v1/watchers/login')) {
        return new Response(
          JSON.stringify({ token: 'lapi-token', expire: new Date(Date.now() + 3600_000).toISOString() }),
          { status: 200 }
        );
      }
      if (url.endsWith('/v1/alerts')) {
        return new Response('["1"]', { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });

  it('does not replicate an unauthenticated signal carrying 0.0.0.0/0', async () => {
    app = await buildApp(false);

    // No Authorization header at all, body claims a trusted machine id.
    const res = await post([signal('0.0.0.0/0', TRUSTED_CAPI_MACHINE)]);

    expect(res.statusCode).toBe(200);
    expect(lapiAlertPosts()).toEqual([]);
    expect(markAlertsReplicated).not.toHaveBeenCalled();
  });

  it('does not replicate when CAPI rejects the token (400), even with validation disabled', async () => {
    app = await buildApp(false);
    capiStatus = 400;

    const res = await post(
      [signal('203.0.113.7')],
      `Bearer ${makeJwt({ id: TRUSTED_CAPI_MACHINE })}`
    );

    // Client validation is disabled: the request itself is still accepted.
    expect(res.statusCode).toBe(200);
    expect(lapiAlertPosts()).toEqual([]);
  });

  it('does not replicate from a fail-open validation (CAPI 503)', async () => {
    app = await buildApp(true);
    capiStatus = 503;

    const res = await post(
      [signal('203.0.113.7')],
      `Bearer ${makeJwt({ id: TRUSTED_CAPI_MACHINE })}`
    );

    // Fail-open lets the batch through, but not into the LAPIs.
    expect(res.statusCode).toBe(200);
    expect(lapiAlertPosts()).toEqual([]);
  });

  it('rejects the request when CAPI answers 400 and client validation is enabled', async () => {
    app = await buildApp(true);
    capiStatus = 400;

    const res = await post([signal('203.0.113.7')], `Bearer ${makeJwt({ id: 'whoever' })}`);

    expect(res.statusCode).toBe(401);
    expect(lapiAlertPosts()).toEqual([]);
  });

  it('does not replicate from a validated sender that is not in the allowlist', async () => {
    app = await buildApp(true);

    const res = await post(
      // The body claims the trusted id; only the JWT counts.
      [signal('203.0.113.7', TRUSTED_CAPI_MACHINE)],
      `Bearer ${makeJwt({ id: 'random-capi-machine' })}`
    );

    expect(res.statusCode).toBe(200);
    expect(lapiAlertPosts()).toEqual([]);
    expect(markAlertsReplicated).not.toHaveBeenCalled();
  });

  it.each([
    ['validation enabled', true],
    ['validation disabled', false],
  ])(
    'replicates from a validated, allowlisted sender to the other LAPIs (%s)',
    async (_label, enabled) => {
      app = await buildApp(enabled);

      const res = await post(
        [signal('203.0.113.7', 'agent-of-lapi2')],
        `Bearer ${makeJwt({ id: TRUSTED_CAPI_MACHINE })}`,
        'v3'
      );

      expect(res.statusCode).toBe(200);
      // lapi1 is the sender (JWT id), so only lapi2 receives the decisions.
      expect(lapiAlertPosts()).toEqual(['https://lapi2.example.test/v1/alerts']);
      expect(markAlertsReplicated).toHaveBeenCalledWith([0]);
    }
  );
});
