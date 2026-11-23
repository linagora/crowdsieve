/**
 * Proxy routes for the filter rules: GET /api/filters, GET /api/filters/stats,
 * POST /api/filters/test, and the `rule` filter of GET /api/alerts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../src/logging.js';
import { FilterEngine } from '../src/filters/index.js';
import { loadFiltersFromDirectory, type Config } from '../src/config/index.js';
import type { AlertQuery, AlertStorage } from '../src/storage/index.js';
import type { SelectAlert } from '../src/db/schema.js';

const TEST_API_KEY = 'test-api-key-filter-rules';
const FILTERS_DIR = path.join(__dirname, '../config/filters.d');

let app: FastifyInstance;
let queries: AlertQuery[];
let statsSince: Array<Date | undefined>;
const storedAlerts = new Map<number, Partial<SelectAlert>>();

function rawAlert(ip: string, decisions: unknown[]) {
  return JSON.stringify({
    scenario: 'crowdsecurity/ssh-bf',
    simulated: false,
    source: { scope: 'Ip', value: ip, ip },
    decisions,
  });
}

const BAN = [{ origin: 'crowdsec', type: 'ban', scope: 'Ip', value: '198.51.100.23' }];

function buildStorage(): AlertStorage {
  return {
    queryAlerts: async (query: AlertQuery) => {
      queries.push(query);
      return [];
    },
    getAlertById: async (id: number) => (storedAlerts.get(id) as SelectAlert) ?? null,
    getFilterRuleStats: async (since?: Date) => {
      statsSince.push(since);
      return {
        total: 16,
        filtered: 6,
        byRule: [{ name: 'internal-ips', count: 3, lastMatchedAt: '2026-11-20T10:00:00.000Z' }],
      };
    },
  } as unknown as AlertStorage;
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;
  const { filters } = loadFiltersFromDirectory(FILTERS_DIR);

  app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.decorate('config', { lapi_servers: [] } as unknown as Config);
  app.decorate('storage', buildStorage());
  app.decorate('filterEngine', new FilterEngine('block', filters));
  app.decorate('proxyLogger', createLogger({ level: 'silent' }));
  app.decorate('clientValidator', undefined);
  app.decorate('replicationService', undefined);
  await app.register(import('../src/proxy/routes/api.js'));
  await app.ready();

  storedAlerts.set(1, { id: 1, localAudit: false, rawJson: rawAlert('10.1.2.3', BAN) });
  storedAlerts.set(2, { id: 2, localAudit: false, rawJson: rawAlert('198.51.100.23', BAN) });
  storedAlerts.set(3, { id: 3, localAudit: true, rawJson: '{"kind":"manual-ban"}' });
  storedAlerts.set(4, { id: 4, localAudit: false, rawJson: null });
  storedAlerts.set(5, { id: 5, localAudit: false, rawJson: '[1,2]' });
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  queries = [];
  statsSince = [];
});

const auth = { 'X-API-Key': TEST_API_KEY };

describe('GET /api/filters', () => {
  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/filters' });
    expect(res.statusCode).toBe(401);
  });

  it('lists the loaded rules with their condition as YAML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/filters', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('block');
    // The _*.disabled example files are not loaded
    expect(body.rules.map((r: { name: string }) => r.name)).toEqual([
      'no-decision',
      'simulated',
      'internal-ips',
    ]);
    const internal = body.rules[2];
    expect(internal).toMatchObject({
      name: 'internal-ips',
      description: 'Block internal IP ranges',
      enabled: true,
      file: '10-internal-ips.yaml',
    });
    expect(Object.keys(internal).sort()).toEqual([
      'condition',
      'description',
      'enabled',
      'file',
      'name',
    ]);
    expect(parseYaml(internal.condition)).toEqual({
      field: 'source.ip',
      op: 'cidr',
      value: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
    });
  });
});

describe('GET /api/filters/stats', () => {
  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/filters/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the per-rule counts, for all time without since', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/filters/stats', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total: 16,
      filtered: 6,
      byRule: [{ name: 'internal-ips', count: 3, lastMatchedAt: '2026-11-20T10:00:00.000Z' }],
    });
    expect(statsSince).toEqual([undefined]);
  });

  it('passes a valid since date to the storage', async () => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/filters/stats?since=${encodeURIComponent(since)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(statsSince[0]?.toISOString()).toBe(since);
  });

  it.each(['yesterday', '2019-12-31T00:00:00Z', '2999-01-01T00:00:00Z'])(
    'rejects since=%s',
    async (since) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/filters/stats?since=${encodeURIComponent(since)}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
      expect(statsSince).toEqual([]);
    }
  );
});

describe('POST /api/filters/test', () => {
  function test(payload: unknown, headers: Record<string, string> = auth) {
    return app.inject({
      method: 'POST',
      url: '/api/filters/test',
      headers,
      payload: payload as object,
    });
  }

  it('requires the API key', async () => {
    const res = await test({ alertId: 1 }, {});
    expect(res.statusCode).toBe(401);
  });

  it('reports the rules that would filter an internal alert', async () => {
    const res = await test({ alertId: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      filtered: true,
      matched: [{ name: 'internal-ips', reason: 'source.ip in CIDR 10.0.0.0/8' }],
    });
  });

  it('reports a public alert with a decision as forwarded', async () => {
    const res = await test({ alertId: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ filtered: false, matched: [] });
  });

  it('answers 404 for an unknown alert', async () => {
    const res = await test({ alertId: 999 });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Alert not found' });
  });

  it('refuses audit rows and alerts without a usable payload', async () => {
    for (const alertId of [3, 4, 5]) {
      const res = await test({ alertId });
      expect(res.statusCode).toBe(422);
    }
  });

  it.each([{}, { alertId: 0 }, { alertId: 'abc' }, { alertId: -3 }])(
    'rejects the body %j',
    async (body) => {
      const res = await test(body);
      expect(res.statusCode).toBe(400);
    }
  );
});

describe('GET /api/alerts?rule=', () => {
  it('passes the rule to the storage query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/alerts?filtered=true&rule=internal-ips',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(queries[0]).toMatchObject({ filtered: true, rule: 'internal-ips' });
  });

  it('rejects an empty or oversized rule name', async () => {
    for (const rule of ['', 'x'.repeat(201)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/alerts?rule=${rule}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(queries).toEqual([]);
  });
});
