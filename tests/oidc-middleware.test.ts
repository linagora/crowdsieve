/**
 * Tests for the dashboard authentication middleware.
 *
 * Focus: the login redirect must keep the full requested target (pathname +
 * query string) so a shared filtered link survives the sign-in flow (#74).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../dashboard/middleware.js';

const originalEnv = { ...process.env };

async function runMiddleware(path: string, cookie?: string): Promise<Response> {
  const headers = cookie ? { cookie } : undefined;
  const request = new NextRequest(`http://localhost:18710${path}`, { headers });
  return middleware(request);
}

beforeEach(() => {
  process.env = { ...originalEnv, AUTH_MODE: 'oidc' };
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

  it('lets a request carrying a session cookie through', async () => {
    const res = await runMiddleware('/decisions?ip=203.0.113.7', 'crowdsieve-session=abc');

    expect(res.headers.get('location')).toBeNull();
  });
});
