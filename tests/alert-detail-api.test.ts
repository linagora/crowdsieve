/**
 * GET /api/alerts/:id (decisions + events) and GET /api/alerts/:id/raw, and
 * the events extraction from the stored payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '../src/logging.js';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';
import type { ReplicationService } from '../src/replication/index.js';
import { extractAlertEvents } from '../src/storage/alertEvents.js';

const TEST_API_KEY = 'test-api-key-alert-detail';

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

function makeEvents(n: number) {
  // Deliberately out of timestamp order
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(),
    meta: [
      { key: 'service', value: 'ssh' },
      { key: 'user', value: `<img src=x onerror=alert(${i})>` },
    ],
  }));
}

let alerts: Record<number, Record<string, unknown>>;
let app: FastifyInstance;

// Same keys as a row of the alerts table (the response schema requires them)
const ALERT_COLUMNS = [
  'uuid',
  'machineId',
  'scenarioHash',
  'scenarioVersion',
  'message',
  'eventsCount',
  'capacity',
  'leakspeed',
  'startAt',
  'stopAt',
  'createdAt',
  'simulated',
  'remediation',
  'replicated',
  'sourceScope',
  'sourceValue',
  'sourceRange',
  'sourceAsNumber',
  'sourceAsName',
  'sourceCn',
  'geoCountryCode',
  'geoCountryName',
  'geoCity',
  'geoRegion',
  'geoLatitude',
  'geoLongitude',
  'geoTimezone',
  'geoIsp',
  'geoOrg',
  'filtered',
  'filterReasons',
  'forwardedToCapi',
  'forwardedAt',
  'localAudit',
  'actor',
  'rawJson',
];

const baseAlert = {
  ...Object.fromEntries(ALERT_COLUMNS.map((c) => [c, null])),
  id: 1,
  scenario: 'crowdsecurity/ssh-bf',
  receivedAt: '2026-01-01T00:00:00.000Z',
  sourceIp: '203.0.113.7',
  uuid: 'u-1',
  hasDecisions: true,
};

function buildMockStorage(): AlertStorage {
  return {
    getAlertById: async (id: number) => alerts[id] ?? null,
    getAlertDecisions: async (id: number) =>
      id === 1
        ? [
            {
              id: 10,
              alertId: 1,
              uuid: null,
              origin: 'crowdsec',
              type: 'ban',
              scope: 'Ip',
              value: '203.0.113.7',
              duration: '4h',
              scenario: 'crowdsecurity/ssh-bf',
              simulated: false,
              until: '2026-01-01T04:00:00Z',
              createdAt: null,
            },
          ]
        : [],
  } as unknown as AlertStorage;
}

beforeAll(async () => {
  process.env.DASHBOARD_API_KEY = TEST_API_KEY;
  app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.setSchemaErrorFormatter((errors, dataVar) => {
    const first = errors[0];
    const err = new Error(
      `${dataVar}${first?.instancePath || ''} ${first?.message || 'Invalid request'}`.trim()
    ) as Error & { statusCode?: number };
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
  alerts = {
    1: { ...baseAlert, rawJson: JSON.stringify({ events: makeEvents(60) }) },
    2: { ...baseAlert, id: 2, hasDecisions: false, rawJson: null },
    3: { ...baseAlert, id: 3, rawJson: '{not json' },
  };
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { 'X-API-Key': TEST_API_KEY } });

describe('GET /api/alerts/:id', () => {
  it('keeps the alert fields and adds decisions, the first 50 events and eventsTotal', async () => {
    const res = await get('/api/alerts/1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: 1,
      scenario: 'crowdsecurity/ssh-bf',
      sourceIp: '203.0.113.7',
    });
    expect(typeof body.rawJson).toBe('string');
    expect(body.decisions).toEqual([
      {
        id: 10,
        type: 'ban',
        scope: 'Ip',
        value: '203.0.113.7',
        duration: '4h',
        origin: 'crowdsec',
        scenario: 'crowdsecurity/ssh-bf',
        until: '2026-01-01T04:00:00Z',
        simulated: false,
      },
    ]);
    expect(body.events).toHaveLength(50);
    expect(body.eventsTotal).toBe(60);
    const times = body.events.map((e: { timestamp: string }) => e.timestamp);
    expect([...times].sort()).toEqual(times);
    expect(body.events[0].meta[1]).toEqual({
      key: 'user',
      value: expect.stringContaining('<img'),
    });
  });

  it('returns empty arrays when nothing is stored', async () => {
    const body = (await get('/api/alerts/2')).json();
    expect(body.decisions).toEqual([]);
    expect(body.events).toEqual([]);
    expect(body.eventsTotal).toBe(0);
    expect((await get('/api/alerts/3')).json().eventsTotal).toBe(0);
  });

  it('answers 404 for an unknown alert and 400 for a bad id', async () => {
    expect((await get('/api/alerts/99')).statusCode).toBe(404);
    expect((await get('/api/alerts/abc')).statusCode).toBe(400);
  });
});

describe('GET /api/alerts/:id/raw', () => {
  it('returns the stored raw JSON', async () => {
    const res = await get('/api/alerts/1/raw');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().rawJson).events).toHaveLength(60);
  });

  it('answers 404 when no raw data is stored, or the alert is unknown', async () => {
    const res = await get('/api/alerts/2/raw');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Raw data not stored' });
    expect((await get('/api/alerts/99/raw')).statusCode).toBe(404);
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts/1/raw' });
    expect(res.statusCode).toBe(401);
  });
});

describe('extractAlertEvents', () => {
  it('tolerates malformed payloads and entries', () => {
    expect(extractAlertEvents(null)).toEqual({ events: [], total: 0 });
    expect(extractAlertEvents('nope')).toEqual({ events: [], total: 0 });
    expect(extractAlertEvents('{"events":"x"}')).toEqual({ events: [], total: 0 });
    const r = extractAlertEvents(
      JSON.stringify({
        events: [
          null,
          { meta: [{ key: 'a', value: 1 }, { key: '', value: 'x' }, 'bad', { key: 'b' }] },
        ],
      })
    );
    expect(r.total).toBe(1);
    expect(r.events[0]).toEqual({
      timestamp: null,
      meta: [
        { key: 'a', value: '1' },
        { key: 'b', value: '' },
      ],
    });
  });

  it('puts undated events last and bounds value length', () => {
    const r = extractAlertEvents(
      JSON.stringify({
        events: [
          { meta: [{ key: 'k', value: 'x'.repeat(5000) }] },
          { timestamp: '2026-01-01T00:00:00Z', meta: [] },
        ],
      })
    );
    expect(r.events[0].timestamp).toBe('2026-01-01T00:00:00Z');
    expect(r.events[1].meta[0].value).toHaveLength(2000);
  });
});
