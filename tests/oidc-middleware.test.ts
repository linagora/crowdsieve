/**
 * Tests for the dashboard authentication middleware.
 *
 * - The login redirect must keep the full requested target (pathname + query
 *   string) so a shared filtered link survives the sign-in flow (#74).
 * - In OIDC mode the session cookie must be unsealed and hold a signed-in,
 *   unexpired session: its mere presence is not enough (GHSA-w3hg-mhhx-fp6w).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sealData } from 'iron-session';
import { middleware } from '../dashboard/middleware.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'middleware-test-session-secret-0123456789';

async function sealSession(data: Record<string, unknown>, password = SESSION_SECRET) {
  return sealData(data, { password });
}

async function liveSessionCookie(overrides: Record<string, unknown> = {}): Promise<string> {
  const seal = await sealSession({
    user: { sub: 'user-1', email: 'alice@example.com' },
    expiresAt: Date.now() + 3600_000,
    sid: 'sid-1',
    ...overrides,
  });
  return `crowdsieve-session=${seal}`;
}

async function runMiddleware(
  path: string,
  cookie?: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  const request = new NextRequest(`http://localhost:18710${path}`, { headers });
  return middleware(request);
}

beforeEach(() => {
  process.env = { ...originalEnv, AUTH_MODE: 'oidc', SESSION_SECRET };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('middleware login redirect', () => {
  it('keeps the query string of the requested page', async () => {
    const res = await runMiddleware('/decisions?ip=203.0.113.7');

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirect')).toBe('/decisions?ip=203.0.113.7');
  });

  it('keeps multiple query parameters', async () => {
    const res = await runMiddleware('/alerts?status=filtered&machine=qa-agent');

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('redirect')).toBe('/alerts?status=filtered&machine=qa-agent');
  });

  it('does not add a redirect parameter for the home page', async () => {
    const res = await runMiddleware('/');

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.has('redirect')).toBe(false);
  });

  it('lets public paths through', async () => {
    const res = await runMiddleware('/login?redirect=%2Fstats');

    expect(res.headers.get('location')).toBeNull();
  });

  it('lets a request carrying a valid session cookie through', async () => {
    const res = await runMiddleware('/decisions?ip=203.0.113.7', await liveSessionCookie());

    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe('middleware OIDC session validation', () => {
  it('redirects a page request carrying an arbitrary session cookie', async () => {
    const res = await runMiddleware('/decisions', 'crowdsieve-session=abc');

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('rejects the login-flow cookie that has no user', async () => {
    // What GET /api/auth/login saves for anyone: genuine seal, no `user`.
    const seal = await sealSession({ state: 's', nonce: 'n', codeVerifier: 'v' });
    const res = await runMiddleware('/decisions', `crowdsieve-session=${seal}`);

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('rejects a session whose expiresAt has passed', async () => {
    const cookie = await liveSessionCookie({ expiresAt: Date.now() - 1000 });
    const res = await runMiddleware('/', cookie);

    expect(res.status).toBe(307);
  });

  it('rejects a session without expiresAt', async () => {
    const cookie = await liveSessionCookie({ expiresAt: undefined });
    const res = await runMiddleware('/', cookie);

    expect(res.status).toBe(307);
  });

  it('rejects a session sealed with another secret', async () => {
    const seal = await sealSession(
      { user: { sub: 'user-1' }, expiresAt: Date.now() + 3600_000 },
      'another-secret-another-secret-0123456789'
    );
    const res = await runMiddleware('/', `crowdsieve-session=${seal}`);

    expect(res.status).toBe(307);
  });

  it('answers 401 JSON to an API call with an arbitrary cookie', async () => {
    const res = await runMiddleware('/api/alerts', 'crowdsieve-session=abc');

    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 401 to an API call with the login-flow cookie', async () => {
    const seal = await sealSession({ state: 's', nonce: 'n', codeVerifier: 'v' });
    const res = await runMiddleware('/api/decisions/ban', `crowdsieve-session=${seal}`);

    expect(res.status).toBe(401);
  });

  it('answers 401 to an API call without cookie', async () => {
    const res = await runMiddleware('/api/alerts');

    expect(res.status).toBe(401);
  });

  it('lets an API call with a valid session through', async () => {
    const res = await runMiddleware('/api/alerts', await liveSessionCookie());

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('middleware without a usable SESSION_SECRET (GHSA-8hgc-3vpr-6r43)', () => {
  it('rejects a session forged with the former public fallback secret', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seal = await sealSession(
      { user: { sub: 'admin' }, expiresAt: Date.now() + 3600_000 },
      'crowdsieve-dev-secret-32-chars!!'
    );

    const page = await runMiddleware('/', `crowdsieve-session=${seal}`);
    expect(page.status).toBe(307);
    const api = await runMiddleware('/api/decisions/ban', `crowdsieve-session=${seal}`);
    expect(api.status).toBe(401);
    errorSpy.mockRestore();
  });

  it('fails closed with a too short SESSION_SECRET in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'too-short';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await runMiddleware('/api/alerts', await liveSessionCookie());
    expect(res.status).toBe(401);
    errorSpy.mockRestore();
  });
});

describe('middleware in headers mode (GHSA-rjx9-mrqq-772w)', () => {
  const PROXY_SECRET = 'proxy-secret-0123456789abcdef0123456789';

  beforeEach(() => {
    process.env.AUTH_MODE = 'headers';
    delete process.env.AUTH_PROXY_SECRET;
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it('rejects forged Auth-* headers without the proxy secret', async () => {
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
    const res = await runMiddleware('/api/alerts', undefined, { 'Auth-Sub': 'admin' });

    expect(res.status).toBe(403);
  });

  it('rejects a wrong proxy secret', async () => {
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
    const res = await runMiddleware('/', undefined, {
      'Auth-Sub': 'admin',
      'X-Auth-Proxy-Secret': 'guess',
    });

    expect(res.status).toBe(403);
  });

  it('accepts the proxy secret with Auth-Sub', async () => {
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
    const res = await runMiddleware('/', undefined, {
      'Auth-Sub': 'user-1',
      'X-Auth-Proxy-Secret': PROXY_SECRET,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('still requires Auth-Sub with a valid proxy secret', async () => {
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
    const res = await runMiddleware('/', undefined, { 'X-Auth-Proxy-Secret': PROXY_SECRET });

    expect(res.status).toBe(401);
  });

  it('rejects a spoofed first X-Forwarded-For entry', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    const res = await runMiddleware('/', undefined, {
      'Auth-Sub': 'admin',
      'X-Forwarded-For': '10.0.0.5, 203.0.113.9',
    });

    expect(res.status).toBe(403);
  });

  it('accepts a request whose closest hop is in TRUSTED_PROXY_IPS', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    const res = await runMiddleware('/', undefined, {
      'Auth-Sub': 'user-1',
      'X-Forwarded-For': '203.0.113.9, 10.0.0.5',
    });

    expect(res.status).toBe(200);
  });
});

describe('middleware CSRF defence (GHSA-2q3x-9jxw-8c7h)', () => {
  // Body of the cross-site form from the advisory: enctype="text/plain".
  const FORM_BODY = '{"server":"lapi","ip":"0.0.0.0/0","duration":"9999h","reason":"x","p":"="}';

  async function post(
    path: string,
    headers: Record<string, string>,
    init: { method?: string; cookie?: string; host?: string } = {}
  ): Promise<Response> {
    const allHeaders: Record<string, string> = { 'content-type': 'text/plain', ...headers };
    if (init.cookie) allHeaders.cookie = init.cookie;
    const request = new NextRequest(`http://${init.host ?? 'dashboard.example:3000'}${path}`, {
      method: init.method ?? 'POST',
      headers: allHeaders,
      body: init.method === 'GET' ? undefined : FORM_BODY,
    });
    return middleware(request);
  }

  it('rejects a cross-origin text/plain POST with 403, even with a valid session', async () => {
    const res = await post(
      '/api/decisions/ban',
      { origin: 'https://evil.example' },
      { cookie: await liveSessionCookie() }
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: cross-origin request' });
  });

  it('rejects it in "none" mode too', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post('/api/decisions/ban', { origin: 'http://evil.example' });

    expect(res.status).toBe(403);
  });

  it('rejects Sec-Fetch-Site other than same-origin', async () => {
    process.env.AUTH_MODE = 'none';
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await post('/api/analyzers/a/run', { 'sec-fetch-site': site });
      expect(res.status).toBe(403);
    }
  });

  it('rejects DELETE, PUT and PATCH from another origin', async () => {
    process.env.AUTH_MODE = 'none';
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const res = await post('/api/decisions/1', { origin: 'https://evil.example' }, { method });
      expect(res.status).toBe(403);
    }
  });

  it('rejects an opaque "null" Origin', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post('/api/decisions/ban', { origin: 'null' });

    expect(res.status).toBe(403);
  });

  it('rejects a sibling subdomain (same-site, other origin)', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post('/api/decisions/ban', { origin: 'http://blog.dashboard.example:3000' });

    expect(res.status).toBe(403);
  });

  it('accepts a same-origin request', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post('/api/decisions/ban', {
      origin: 'http://dashboard.example:3000',
      'sec-fetch-site': 'same-origin',
    });

    expect(res.status).toBe(200);
  });

  it('accepts the public origin seen through a proxy (X-Forwarded-Host)', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post(
      '/api/decisions/ban',
      { origin: 'https://crowdsieve.example.com', 'x-forwarded-host': 'crowdsieve.example.com' },
      { host: 'crowdsieve:3000' }
    );

    expect(res.status).toBe(200);
  });

  it('accepts the origin of NEXTAUTH_URL', async () => {
    process.env.AUTH_MODE = 'none';
    process.env.NEXTAUTH_URL = 'https://crowdsieve.example.com';
    const res = await post(
      '/api/decisions/ban',
      { origin: 'https://crowdsieve.example.com' },
      { host: 'crowdsieve:3000' }
    );

    expect(res.status).toBe(200);
  });

  it('lets requests without Origin nor Sec-Fetch-Site reach the auth checks', async () => {
    const res = await post('/api/decisions/ban', {});

    expect(res.status).toBe(401);
  });

  it('does not apply to safe methods', async () => {
    process.env.AUTH_MODE = 'none';
    const res = await post('/api/alerts', { 'sec-fetch-site': 'cross-site' }, { method: 'GET' });

    expect(res.status).toBe(200);
  });

  it('does not apply to the back-channel logout called by the IdP', async () => {
    const res = await post('/api/auth/backchannel-logout', {
      origin: 'https://sso.example.com',
      'sec-fetch-site': 'cross-site',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
