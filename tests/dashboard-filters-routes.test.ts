/**
 * Dashboard API routes of the Filters page: /api/filters, /api/filters/stats
 * and /api/filters/test (session guard, JSON content type, what is forwarded).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sealData } from 'iron-session';

const state = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => new Headers()),
}));

import { GET as filtersGet } from '../dashboard/app/api/filters/route.js';
import { GET as statsGet } from '../dashboard/app/api/filters/stats/route.js';
import { POST as testPost } from '../dashboard/app/api/filters/test/route.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'filters-test-session-secret-0123456789abcdef';

let fetchMock: ReturnType<typeof vi.fn>;
let upstream: { status: number; body: unknown };

async function signIn(): Promise<void> {
  const session = {
    user: { sub: 'user-1', email: 'alice@example.com' },
    expiresAt: Date.now() + 3600_000,
    sid: `sid-${Math.random()}`,
  };
  state.cookies.set('crowdsieve-session', await sealData(session, { password: SESSION_SECRET }));
}

function testRequest(body: string, contentType = 'application/json'): NextRequest {
  return new NextRequest('http://localhost:3000/api/filters/test', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    AUTH_MODE: 'oidc',
    SESSION_SECRET,
    DASHBOARD_API_KEY: 'k',
    API_URL: 'http://proxy:8080',
  };
  state.cookies.clear();
  upstream = { status: 200, body: { ok: true } };
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(upstream.body), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session guard', () => {
  it('rejects every filters route without a session', async () => {
    expect((await filtersGet()).status).toBe(401);
    expect(
      (await statsGet(new NextRequest('http://localhost:3000/api/filters/stats'))).status
    ).toBe(401);
    expect((await testPost(testRequest('{"alertId":1}'))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('with a session', () => {
  beforeEach(signIn);

  it('GET /api/filters proxies the rule list with the API key', async () => {
    upstream.body = { mode: 'block', rules: [] };
    const res = await filtersGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'block', rules: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://proxy:8080/api/filters');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
  });

  it('GET /api/filters/stats forwards only since', async () => {
    await statsGet(
      new NextRequest(
        'http://localhost:3000/api/filters/stats?since=2026-11-01T00:00:00.000Z&limit=5&x=y'
      )
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://proxy:8080/api/filters/stats?since=2026-11-01T00%3A00%3A00.000Z'
    );

    await statsGet(new NextRequest('http://localhost:3000/api/filters/stats'));
    expect(fetchMock.mock.calls[1][0]).toBe('http://proxy:8080/api/filters/stats');
  });

  it('GET /api/filters/stats passes an upstream error status through', async () => {
    upstream = { status: 400, body: { error: 'Since date out of acceptable range' } };
    const res = await statsGet(
      new NextRequest('http://localhost:3000/api/filters/stats?since=1999-01-01T00:00:00Z')
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/filters/test requires a JSON content type', async () => {
    const res = await testPost(testRequest('{"alertId":1}', 'text/plain'));
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/filters/test forwards only the alert id', async () => {
    upstream.body = { filtered: true, matched: [{ name: 'internal-ips', reason: 'r' }] };
    const res = await testPost(testRequest('{"alertId":42,"other":"x"}'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream.body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://proxy:8080/api/filters/test');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"alertId":42}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('POST /api/filters/test passes "Alert not found" through', async () => {
    upstream = { status: 404, body: { error: 'Alert not found' } };
    const res = await testPost(testRequest('{"alertId":999}'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Alert not found' });
  });

  it.each(['not json', '{}', '{"alertId":"1"}', '{"alertId":0}', '{"alertId":1.5}', 'null', '5'])(
    'POST /api/filters/test rejects the body %s',
    async (body) => {
      const res = await testPost(testRequest(body));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
