/**
 * Server-side session guard of the dashboard API routes (GHSA-w3hg-mhhx-fp6w).
 *
 * The middleware is not the only gate: every API route outside `/api/auth`
 * and `/api/jwks` calls `requireAuth()`, which validates the session for the
 * configured auth mode (including back-channel revocation in OIDC mode).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sealData } from 'iron-session';

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => state.headers),
}));

import { POST as banPost } from '../dashboard/app/api/decisions/ban/route.js';
import { GET as alertsGet } from '../dashboard/app/api/alerts/route.js';
import { GET as statusGet } from '../dashboard/app/api/status/route.js';
import { POST as analyzerRunPost } from '../dashboard/app/api/analyzers/[id]/run/route.js';
import { DELETE as decisionDelete } from '../dashboard/app/api/decisions/[id]/route.js';
import { GET as loginGet } from '../dashboard/app/api/auth/login/route.js';
import { GET as callbackGet } from '../dashboard/app/api/auth/callback/route.js';
import { revokeSession } from '../dashboard/lib/oidc/revocation.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'guard-test-session-secret-0123456789abcdef';

let fetchMock: ReturnType<typeof vi.fn>;

async function setSessionCookie(data: Record<string, unknown> | string): Promise<void> {
  const value =
    typeof data === 'string' ? data : await sealData(data, { password: SESSION_SECRET });
  state.cookies.set('crowdsieve-session', value);
}

function liveSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { sub: 'user-1', email: 'alice@example.com' },
    expiresAt: Date.now() + 3600_000,
    sid: `sid-${Math.random()}`,
    ...overrides,
  };
}

function banRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/decisions/ban', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: 'lapi', ip: '0.0.0.0/0', duration: '4h', reason: 'x' }),
  });
}

function alertsRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/alerts?limit=10');
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    AUTH_MODE: 'oidc',
    SESSION_SECRET,
    DASHBOARD_API_KEY: 'k',
  };
  state.cookies.clear();
  state.headers = new Headers();
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
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

describe('API route guard in OIDC mode', () => {
  it('rejects POST /api/decisions/ban without a session cookie', async () => {
    const res = await banPost(banRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects POST /api/decisions/ban with an arbitrary cookie', async () => {
    await setSessionCookie('anything');
    const res = await banPost(banRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects POST /api/decisions/ban with the login-flow cookie (no user)', async () => {
    await setSessionCookie({ state: 's', nonce: 'n', codeVerifier: 'v' });
    const res = await banPost(banRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects GET /api/alerts with an arbitrary cookie', async () => {
    await setSessionCookie('anything');
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects GET /api/status without a session', async () => {
    const res = await statusGet();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a valid session read GET /api/status', async () => {
    await setSessionCookie(liveSession());
    const res = await statusGet();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/status');
  });

  it('rejects GET /api/alerts with the login-flow cookie (no user)', async () => {
    await setSessionCookie({ state: 's', nonce: 'n', codeVerifier: 'v' });
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an expired session', async () => {
    await setSessionCookie(liveSession({ expiresAt: Date.now() - 1 }));
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(401);
  });

  it('rejects a session revoked by back-channel logout', async () => {
    await setSessionCookie(liveSession({ sid: 'sid-revoked', user: { sub: 'user-revoked' } }));
    revokeSession('sid-revoked', 'user-revoked');
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a valid session through and records the actor', async () => {
    await setSessionCookie(liveSession());
    const res = await banPost(banRequest());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Crowdsieve-Actor']).toBe('user-1');
  });
});

describe('API route guard in other modes', () => {
  it('headers mode: rejects a request without Auth-Sub', async () => {
    process.env.AUTH_MODE = 'headers';
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('headers mode: lets a request with Auth-Sub through', async () => {
    process.env.AUTH_MODE = 'headers';
    state.headers = new Headers({ 'Auth-Sub': 'user-1' });
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('headers mode: rejects Auth-Sub without the AUTH_PROXY_SECRET', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_PROXY_SECRET = 'proxy-secret-0123456789abcdef0123456789';
    state.headers = new Headers({ 'Auth-Sub': 'admin', 'X-Auth-Proxy-Secret': 'guess' });
    const res = await banPost(banRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('headers mode: accepts Auth-Sub with the AUTH_PROXY_SECRET', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_PROXY_SECRET = 'proxy-secret-0123456789abcdef0123456789';
    state.headers = new Headers({
      'Auth-Sub': 'user-1',
      'X-Auth-Proxy-Secret': 'proxy-secret-0123456789abcdef0123456789',
    });
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(200);
  });

  it('none mode: no session is required', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(200);
  });
});

describe('OIDC mode without a usable SESSION_SECRET (GHSA-8hgc-3vpr-6r43)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'https://sso.example.com';
    process.env.OIDC_CLIENT_ID = 'crowdsieve';
    delete process.env.SESSION_SECRET;
  });

  it('API routes answer 500 with a clear message', async () => {
    await setSessionCookie(liveSession());
    const res = await alertsGet(alertsRequest());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/SESSION_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/auth/login answers 500 and starts no login flow', async () => {
    const res = await loginGet(new NextRequest('http://localhost:3000/api/auth/login'));

    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/SESSION_SECRET must be set/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/auth/callback answers 500', async () => {
    const res = await callbackGet(
      new NextRequest('http://localhost:3000/api/auth/callback?code=c&state=s')
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a too short SESSION_SECRET is rejected as well', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(31);
    const res = await loginGet(new NextRequest('http://localhost:3000/api/auth/login'));

    expect(res.status).toBe(500);
  });
});

describe('JSON write routes require Content-Type: application/json (GHSA-2q3x-9jxw-8c7h)', () => {
  // Body of the cross-site form from the advisory: enctype="text/plain".
  const FORM_BODY = '{"server":"lapi","ip":"0.0.0.0/0","duration":"9999h","reason":"x","p":"="}';

  beforeEach(async () => {
    await setSessionCookie(liveSession());
  });

  it('POST /api/decisions/ban rejects a text/plain body with 415', async () => {
    const res = await banPost(
      new NextRequest('http://localhost:3000/api/decisions/ban', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: FORM_BODY,
      })
    );

    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/decisions/ban rejects a form-encoded body with 415', async () => {
    const res = await banPost(
      new NextRequest('http://localhost:3000/api/decisions/ban', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'ip=0.0.0.0%2F0',
      })
    );

    expect(res.status).toBe(415);
  });

  it('POST /api/decisions/ban accepts application/json with a charset', async () => {
    const res = await banPost(
      new NextRequest('http://localhost:3000/api/decisions/ban', {
        method: 'POST',
        headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        body: JSON.stringify({ server: 'lapi', ip: '192.0.2.1', duration: '4h', reason: 'x' }),
      })
    );

    expect(res.status).toBe(200);
  });

  it('POST /api/analyzers/:id/run rejects a request without JSON content type', async () => {
    const res = await analyzerRunPost(
      new NextRequest('http://localhost:3000/api/analyzers/a/run', { method: 'POST' }),
      { params: Promise.resolve({ id: 'a' }) }
    );

    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/analyzers/:id/run accepts a JSON request', async () => {
    const res = await analyzerRunPost(
      new NextRequest('http://localhost:3000/api/analyzers/a/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ id: 'a' }) }
    );

    expect(res.status).toBe(200);
  });

  it('DELETE /api/decisions/:id rejects a text/plain body with 415', async () => {
    const res = await decisionDelete(
      new NextRequest('http://localhost:3000/api/decisions/1?server=lapi', {
        method: 'DELETE',
        headers: { 'content-type': 'text/plain' },
        body: '{"ip":"192.0.2.1","reason":"x"}',
      }),
      { params: Promise.resolve({ id: '1' }) }
    );

    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the session before the content type', async () => {
    state.cookies.clear();
    const res = await analyzerRunPost(
      new NextRequest('http://localhost:3000/api/analyzers/a/run', { method: 'POST' }),
      { params: Promise.resolve({ id: 'a' }) }
    );

    expect(res.status).toBe(401);
  });
});
