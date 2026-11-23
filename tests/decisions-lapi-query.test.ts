/**
 * Proxy routes reading the decisions of the LAPI servers:
 *   - GET /api/decisions?ip=        (search; a range also finds the decisions inside it, #140)
 *   - GET /api/decisions/active     (active decisions of every LAPI with filters, #129)
 *
 * The LAPI servers are mocked through global fetch; each test inspects the
 * `GET /v1/decisions` query strings the routes sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';
import {
  LOCAL_DECISION_ORIGINS,
  isSharedOrigin,
  normalizeLapiDecision,
} from '../src/proxy/lapiDecisions.js';
import { MAX_ACTIVE_DECISIONS_PER_SERVER } from '../src/proxy/routes/api.js';

const TEST_API_KEY = 'test-api-key-decisions-lapi-query';

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
        name: 'lapi-a',
        url: 'http://lapi-a.test:8080',
        api_key: 'key-a',
        replicate_decisions: false,
      },
      {
        name: 'lapi-b',
        url: 'http://lapi-b.test:8080',
        api_key: 'key-b',
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

// The decision read routes never touch the storage.
function buildMockStorage(): AlertStorage {
  return {} as AlertStorage;
}

interface LapiCall {
  host: string;
  params: URLSearchParams;
  apiKey: string | null;
}

type LapiAnswer = { status: number; body: unknown } | Error;

let app: FastifyInstance;
let calls: LapiCall[];
// Answer of each mocked LAPI, by host, computed from the query parameters.
let answers: Record<string, (params: URLSearchParams) => LapiAnswer>;

function decision(id: number, value: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    origin: 'cscli',
    type: 'ban',
    scope: value.includes('/') ? 'Range' : 'Ip',
    value,
    duration: '3h56m24.5s',
    scenario: 'manual',
    ...extra,
  };
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const apiKey = new Headers(init?.headers).get('X-Api-Key');
      calls.push({ host: url.host, params: url.searchParams, apiKey });
      const answer = answers[url.host]?.(url.searchParams) ?? { status: 404, body: 'not found' };
      if (answer instanceof Error) throw answer;
      return new Response(
        typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
        { status: answer.status, headers: { 'Content-Type': 'application/json' } }
      );
    })
  );

  app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
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
});

beforeEach(() => {
  calls = [];
  answers = {
    'lapi-a.test:8080': () => ({ status: 200, body: null }),
    'lapi-b.test:8080': () => ({ status: 200, body: null }),
  };
});

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { 'X-API-Key': TEST_API_KEY } });
}

function callsTo(host: string): Array<Record<string, string>> {
  return calls
    .filter((c) => c.host === host)
    .map((c) => Object.fromEntries(c.params))
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
}

describe('lapiDecisions helpers', () => {
  it('recognises the community blocklist origins, case-insensitively', () => {
    expect(isSharedOrigin('CAPI')).toBe(true);
    expect(isSharedOrigin('capi')).toBe(true);
    expect(isSharedOrigin('lists')).toBe(true);
    expect(isSharedOrigin('crowdsec')).toBe(false);
    expect(isSharedOrigin('cscli')).toBe(false);
    expect(isSharedOrigin('')).toBe(false);
    expect(isSharedOrigin(undefined)).toBe(false);
  });

  it('never lists a shared origin among the local ones', () => {
    expect(LOCAL_DECISION_ORIGINS.some((o) => isSharedOrigin(o))).toBe(false);
    expect(LOCAL_DECISION_ORIGINS).toEqual(
      expect.arrayContaining(['crowdsec', 'cscli', 'crowdsieve', 'crowdsieve-replication'])
    );
  });

  it('normalizes a LAPI decision and drops entries without a numeric id', () => {
    expect(normalizeLapiDecision({ ...decision(7, '192.0.2.1'), until: '', extra: 1 })).toEqual(
      decision(7, '192.0.2.1')
    );
    expect(normalizeLapiDecision({ ...decision(7, '192.0.2.1'), uuid: 'u', until: 'x' })).toEqual({
      ...decision(7, '192.0.2.1'),
      uuid: 'u',
      until: 'x',
    });
    expect(normalizeLapiDecision({ id: 3, value: '192.0.2.1' })).toEqual({
      id: 3,
      origin: '',
      type: '',
      scope: '',
      value: '192.0.2.1',
      duration: '',
      scenario: '',
    });
    expect(normalizeLapiDecision({ ...decision(1, 'x'), id: '1' })).toBeNull();
    expect(normalizeLapiDecision(null)).toBeNull();
    expect(normalizeLapiDecision('x')).toBeNull();
  });
});

describe('GET /api/decisions (search)', () => {
  it('looks a single IP up with ip= (unchanged behaviour)', async () => {
    answers['lapi-a.test:8080'] = () => ({ status: 200, body: [decision(1, '203.0.113.7')] });
    const res = await get('/api/decisions?ip=203.0.113.7');
    expect(res.statusCode).toBe(200);
    expect(callsTo('lapi-a.test:8080')).toEqual([{ ip: '203.0.113.7' }]);
    const body = res.json();
    expect(body.ip).toBe('203.0.113.7');
    expect(body.results).toEqual([
      { server: 'lapi-a', decisions: [decision(1, '203.0.113.7')] },
      { server: 'lapi-b', decisions: [] },
    ]);
  });

  it('looks a range up around and inside it, and lists each decision once', async () => {
    answers['lapi-a.test:8080'] = (params) =>
      params.get('contains') === 'false'
        ? // inside 192.0.2.0/24: the /28 and a single IP
          { status: 200, body: [decision(3, '192.0.2.0/28'), decision(4, '192.0.2.9')] }
        : // containing 192.0.2.0/24: a /16 and... nothing else
          { status: 200, body: [decision(2, '192.0.0.0/16')] };
    const res = await get('/api/decisions?ip=192.0.2.0/24');
    expect(res.statusCode).toBe(200);
    expect(callsTo('lapi-a.test:8080')).toEqual([
      { contains: 'false', range: '192.0.2.0/24' },
      { range: '192.0.2.0/24' },
    ]);
    const [a] = res.json().results;
    expect(a.decisions.map((d: { id: number }) => d.id)).toEqual([2, 3, 4]);
  });

  it('merges the two answers by decision id (an exact range match comes back twice)', async () => {
    answers['lapi-a.test:8080'] = () => ({ status: 200, body: [decision(3, '192.0.2.0/28')] });
    const res = await get('/api/decisions?ip=192.0.2.0/28');
    const [a] = res.json().results;
    expect(a.decisions).toEqual([decision(3, '192.0.2.0/28')]);
  });

  it('treats a null LAPI answer as no decision', async () => {
    const res = await get('/api/decisions?ip=10.0.0.0/8');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ip: '10.0.0.0/8',
      results: [
        { server: 'lapi-a', decisions: [] },
        { server: 'lapi-b', decisions: [] },
      ],
      shared: [],
    });
  });

  it('reports a failing range query as a server error', async () => {
    answers['lapi-a.test:8080'] = (params) =>
      params.get('contains') === 'false'
        ? { status: 500, body: 'boom' }
        : { status: 200, body: [decision(2, '192.0.0.0/16')] };
    const res = await get('/api/decisions?ip=192.0.2.0/24');
    const [a] = res.json().results;
    expect(a.error).toBe('LAPI error: 500');
  });
});

describe('GET /api/decisions/active', () => {
  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/decisions/active' });
    expect(res.statusCode).toBe(401);
  });

  it('lists the local decisions of every LAPI by default', async () => {
    answers['lapi-a.test:8080'] = () => ({
      status: 200,
      body: [decision(1, '203.0.113.7'), decision(2, '198.51.100.23')],
    });
    answers['lapi-b.test:8080'] = () => ({
      status: 200,
      body: [decision(9, '192.0.2.0/28', { type: 'captcha' })],
    });
    const res = await get('/api/decisions/active');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { server: 'lapi-a', decisions: [decision(1, '203.0.113.7'), decision(2, '198.51.100.23')] },
        { server: 'lapi-b', decisions: [decision(9, '192.0.2.0/28', { type: 'captcha' })] },
      ],
    });
    const origins = LOCAL_DECISION_ORIGINS.join(',');
    expect(callsTo('lapi-a.test:8080')).toEqual([{ origins }]);
    expect(callsTo('lapi-b.test:8080')).toEqual([{ origins }]);
    expect(calls.find((c) => c.host === 'lapi-b.test:8080')?.apiKey).toBe('key-b');
  });

  it('maps the filters to LAPI query parameters', async () => {
    const res = await get(
      '/api/decisions/active?type=captcha&origin=cscli&scenario=%20ssh-bf%20&value=203.0.113.7'
    );
    expect(res.statusCode).toBe(200);
    expect(callsTo('lapi-a.test:8080')).toEqual([
      { ip: '203.0.113.7', origins: 'cscli', scenarios_containing: 'ssh-bf', type: 'captcha' },
    ]);
  });

  it('finds the decisions inside a CIDR filter', async () => {
    await get('/api/decisions/active?value=192.0.2.0/24');
    expect(callsTo('lapi-a.test:8080')).toEqual([
      {
        contains: 'false',
        origins: LOCAL_DECISION_ORIGINS.join(','),
        range: '192.0.2.0/24',
      },
    ]);
  });

  it('queries only the named server', async () => {
    const res = await get('/api/decisions/active?server=lapi-b');
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { server: string }) => r.server)).toEqual(['lapi-b']);
    expect(callsTo('lapi-a.test:8080')).toEqual([]);
  });

  it('answers 404 for an unknown server', async () => {
    const res = await get('/api/decisions/active?server=nope');
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['value=not-an-ip'],
    ['value=192.0.2.0/33'],
    ['type=ban%3Bdrop'],
    ['origin=a%2Cb'],
    ['server=..%2Fetc'],
    ['scenario=a%0Ab'],
    ['include_shared=maybe'],
    [`scenario=${'x'.repeat(201)}`],
  ])('rejects the invalid filter %s with 400', async (query) => {
    const res = await get(`/api/decisions/active?${query}`);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('includes the community blocklists only on request', async () => {
    const all = [decision(1, '203.0.113.7'), decision(2, '1.2.3.4', { origin: 'CAPI' })];
    answers['lapi-a.test:8080'] = () => ({ status: 200, body: all });

    // A LAPI that ignores the origins filter must not leak CAPI decisions
    const hidden = await get('/api/decisions/active?server=lapi-a');
    expect(hidden.json().results[0].decisions).toEqual([decision(1, '203.0.113.7')]);

    calls = [];
    const shown = await get('/api/decisions/active?server=lapi-a&include_shared=true');
    expect(shown.json().results[0].decisions).toEqual(all);
    expect(callsTo('lapi-a.test:8080')).toEqual([{}]);
  });

  it('matches nothing for a shared origin unless shared decisions are included', async () => {
    const res = await get('/api/decisions/active?origin=CAPI');
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { server: 'lapi-a', decisions: [] },
      { server: 'lapi-b', decisions: [] },
    ]);
    expect(calls).toHaveLength(0);

    await get('/api/decisions/active?origin=CAPI&include_shared=true');
    expect(callsTo('lapi-a.test:8080')).toEqual([{ origins: 'CAPI' }]);
  });

  it('reports an unreachable LAPI and still lists the other servers', async () => {
    answers['lapi-a.test:8080'] = () => new TypeError('fetch failed');
    answers['lapi-b.test:8080'] = () => ({ status: 200, body: [decision(5, '198.51.100.23')] });
    const res = await get('/api/decisions/active');
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { server: 'lapi-a', decisions: [], error: 'fetch failed' },
      { server: 'lapi-b', decisions: [decision(5, '198.51.100.23')] },
    ]);
  });

  it('reports a LAPI error status and an unexpected body', async () => {
    answers['lapi-a.test:8080'] = () => ({ status: 403, body: { message: 'forbidden' } });
    answers['lapi-b.test:8080'] = () => ({ status: 200, body: { not: 'a list' } });
    const res = await get('/api/decisions/active');
    expect(res.json().results).toEqual([
      { server: 'lapi-a', decisions: [], error: 'LAPI error: 403' },
      { server: 'lapi-b', decisions: [], error: 'Unexpected LAPI response' },
    ]);
  });

  it('caps the decisions of a server and says so', async () => {
    const many = Array.from({ length: MAX_ACTIVE_DECISIONS_PER_SERVER + 5 }, (_, i) =>
      decision(i + 1, '203.0.113.7')
    );
    answers['lapi-a.test:8080'] = () => ({ status: 200, body: many });
    const res = await get('/api/decisions/active?server=lapi-a');
    const [a] = res.json().results;
    expect(a.decisions).toHaveLength(MAX_ACTIVE_DECISIONS_PER_SERVER);
    expect(a.truncated).toBe(true);
    expect(a.total).toBe(MAX_ACTIVE_DECISIONS_PER_SERVER + 5);
  });
});
