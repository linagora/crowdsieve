/**
 * The /v2 and /v3 passthrough hook forwards requests to CAPI. Dashboard
 * credentials (X-API-Key) and the audit identity (X-Crowdsieve-Actor) must
 * never leave the proxy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createProxyServer } from '../src/proxy/server.js';
import { createLogger } from '../src/logging.js';
import { FilterEngine } from '../src/filters/index.js';
import type { AlertStorage } from '../src/storage/index.js';
import type { Config } from '../src/config/index.js';

const CAPI_URL = 'https://capi.example.test';
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
});

describe('CAPI passthrough', () => {
  it('does not forward x-api-key or x-crowdsieve-actor', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      proxy: { listen_port: 8080, capi_url: CAPI_URL, timeout_ms: 5000, forward_enabled: true },
      lapi_servers: [],
      storage: { type: 'sqlite', path: ':memory:', retention_days: 30 },
      logging: { level: 'silent', format: 'json' },
      filters: { mode: 'block', rules: [] },
      client_validation: { enabled: false },
    } as unknown as Config;
    app = await createProxyServer({
      config,
      filterEngine: new FilterEngine('block', []),
      storage: {} as unknown as AlertStorage,
      logger: createLogger({ level: 'silent' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v2/decisions/stream',
      headers: {
        authorization: 'Bearer t',
        'x-api-key': 'dashboard-secret',
        'X-Crowdsieve-Actor': 'alice',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${CAPI_URL}/v2/decisions/stream`);
    const names = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
    expect(names).toContain('authorization');
    expect(names).not.toContain('x-api-key');
    expect(names).not.toContain('x-crowdsieve-actor');
  });
});
