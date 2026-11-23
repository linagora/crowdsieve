/**
 * DELETE /api/decisions/[id] on the dashboard: the id is interpolated into a
 * proxy URL, so anything but a numeric id is rejected before any proxy call.
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

import { DELETE } from '../dashboard/app/api/decisions/[id]/route.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'decisions-route-session-secret-0123456789ab';
let fetchMock: ReturnType<typeof vi.fn>;

async function signIn(): Promise<void> {
  const session = {
    user: { sub: 'user-1', email: 'alice@example.com' },
    expiresAt: Date.now() + 3600_000,
    sid: `sid-${Math.random()}`,
  };
  state.cookies.set('crowdsieve-session', await sealData(session, { password: SESSION_SECRET }));
}

function call(id: string) {
  const request = new NextRequest('http://localhost:3000/api/decisions/x?server=lapi1', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{"reason":"r"}',
  });
  return DELETE(request, { params: Promise.resolve({ id }) });
}

beforeEach(async () => {
  process.env = {
    ...originalEnv,
    AUTH_MODE: 'oidc',
    SESSION_SECRET,
    DASHBOARD_API_KEY: 'k',
    API_URL: 'http://proxy:8080',
  };
  state.cookies.clear();
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await signIn();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('DELETE /api/decisions/[id]', () => {
  it.each(['../../v2/watchers/self', '1?server=other#', '1/../2', '', 'abc', '-1', '1 '])(
    'rejects %j before any proxy call',
    async (id) => {
      const res = await call(id);
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('forwards a numeric id', async () => {
    const res = await call('42');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('http://proxy:8080/api/decisions/42?server=lapi1');
  });
});
