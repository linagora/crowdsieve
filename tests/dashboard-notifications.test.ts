/**
 * Dashboard side of the notifications: the /api/notifications and
 * /api/notifications/[name]/test route handlers (session guard, JSON content
 * type, what is forwarded to the proxy) and the labels of the status card.
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

import { GET as notificationsGet } from '../dashboard/app/api/notifications/route.js';
import { POST as testPost } from '../dashboard/app/api/notifications/[name]/test/route.js';
import {
  intervalLabel,
  isValidTargetName,
  lastDeliveryLabel,
  matchSummary,
  retryingLabel,
  testResultLabel,
} from '../dashboard/lib/notifications.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'notifications-test-session-secret-0123456789';
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const MIN = 60_000;

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

function testRequest(name: string, contentType: string | null = 'application/json') {
  const request = new NextRequest(`http://localhost:3000/api/notifications/${name}/test`, {
    method: 'POST',
    headers: contentType ? { 'content-type': contentType } : {},
    body: '{}',
  });
  return testPost(request, { params: Promise.resolve({ name }) });
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
  upstream = { status: 200, body: { ok: true, message: 'Delivered' } };
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
  it('rejects both routes without a session', async () => {
    expect((await notificationsGet()).status).toBe(401);
    expect((await testRequest('chat')).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/notifications', () => {
  it('forwards to the proxy with the API key', async () => {
    await signIn();
    upstream.body = { enabled: false, dashboardUrl: null, targets: [] };
    const res = await notificationsGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream.body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://proxy:8080/api/notifications');
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-Key': 'k' });
  });

  it('maps proxy errors', async () => {
    await signIn();
    upstream = { status: 503, body: { error: 'x' } };
    const res = await notificationsGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Failed to fetch notifications' });
  });
});

describe('POST /api/notifications/[name]/test', () => {
  it('requires the JSON content type', async () => {
    await signIn();
    expect((await testRequest('chat', 'text/plain')).status).toBe(415);
    expect((await testRequest('chat', null)).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid target names', async () => {
    await signIn();
    expect((await testRequest('..%2F..%2Fapi')).status).toBe(400);
    expect((await testRequest('a b')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the proxy without forwarding the client body', async () => {
    await signIn();
    const res = await testRequest('soc-chat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Delivered' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://proxy:8080/api/notifications/soc-chat/test');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-Key': 'k' });
  });

  it('passes the proxy status and error through', async () => {
    await signIn();
    upstream = { status: 404, body: { error: 'Notification target not found' } };
    const res = await testRequest('missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Notification target not found' });
  });
});

describe('card labels', () => {
  it('describes the last delivery', () => {
    expect(lastDeliveryLabel({ lastResult: null }, NOW)).toEqual({
      tone: 'slate',
      text: 'No delivery yet',
    });
    expect(
      lastDeliveryLabel(
        {
          lastResult: {
            at: NOW - 3 * MIN,
            ok: true,
            event: 'alert',
            message: 'Delivered',
            attempts: 1,
          },
        },
        NOW
      )
    ).toEqual({ tone: 'green', text: 'Delivered 3 min ago' });
    expect(
      lastDeliveryLabel(
        {
          lastResult: {
            at: NOW - 2 * MIN,
            ok: false,
            event: 'alert',
            message: 'HTTP 500',
            attempts: 4,
          },
        },
        NOW
      )
    ).toEqual({ tone: 'red', text: 'Failed 2 min ago: HTTP 500' });
  });

  it('describes retries, the alert filter, the interval and the test result', () => {
    expect(retryingLabel({ retrying: null })).toBeNull();
    expect(
      retryingLabel({
        retrying: { attempt: 1, maxAttempts: 4, nextAttemptAt: NOW, message: 'HTTP 500' },
      })
    ).toBe('Retrying (attempt 2 of 4) after HTTP 500');
    expect(matchSummary(null)).toBeNull();
    expect(
      matchSummary({
        scenarios: ['ssh-bf', 'smtp'],
        countries: ['FR'],
        machines: [],
        status: 'forwarded',
      })
    ).toBe('Scenarios: ssh-bf, smtp · Countries: FR · Alerts that passed the filters');
    expect(matchSummary({ scenarios: [], countries: [], machines: ['m1'], status: 'any' })).toBe(
      'Machines: m1 · All alerts'
    );
    expect(intervalLabel({ minInterval: '5m', minIntervalMs: 300_000 })).toBe(
      'Events grouped over 5m'
    );
    expect(intervalLabel({ minInterval: '0', minIntervalMs: 0 })).toBe(
      'Every event sent on its own'
    );
    expect(testResultLabel({ ok: true, message: 'Delivered' })).toBe('Delivered');
    expect(testResultLabel({ ok: false, message: 'HTTP 404' })).toBe('Failed: HTTP 404');
  });

  it('validates target names like the proxy', () => {
    expect(isValidTargetName('soc-chat_2')).toBe(true);
    expect(isValidTargetName('')).toBe(false);
    expect(isValidTargetName('a/b')).toBe(false);
    expect(isValidTargetName('x'.repeat(65))).toBe(false);
  });
});
