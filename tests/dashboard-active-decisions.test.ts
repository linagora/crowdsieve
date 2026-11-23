/**
 * Active decisions of the Decisions page (#129): URL filters, query to the
 * dashboard API, rows/sorting/paging, bulk unban, and the API route.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DEFAULT_ACTIVE_DECISION_FILTERS,
  buildActiveDecisionsQuery,
  flattenActiveDecisions,
  formatPageRange,
  ipOrCidrKind,
  isSharedOrigin,
  pageWindow,
  parseActiveDecisionParams,
  writeActiveDecisionParams,
  type ActiveDecisionFilters,
} from '../dashboard/lib/activeDecisions.js';
import {
  bulkUnban,
  makeDeleteDecision,
  runWithConcurrency,
  summarizeUnbanResults,
  type UnbanResult,
} from '../dashboard/lib/bulkUnban.js';
import type { Decision } from '../dashboard/lib/types.js';

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

import { GET as activeGet } from '../dashboard/app/api/decisions/active/route.js';

function filters(overrides: Partial<ActiveDecisionFilters> = {}): ActiveDecisionFilters {
  return { ...DEFAULT_ACTIVE_DECISION_FILTERS, ...overrides };
}

function decision(id: number, value: string, extra: Partial<Decision> = {}): Decision {
  return {
    id,
    origin: 'cscli',
    type: 'ban',
    scope: 'Ip',
    value,
    duration: '1h',
    scenario: 'manual',
    ...extra,
  };
}

describe('active decision filters in the URL', () => {
  it('round-trips the filters and keeps unrelated parameters', () => {
    const params = new URLSearchParams('ip=203.0.113.7');
    const f = filters({
      server: 'lapi-qa',
      type: 'captcha',
      origin: 'cscli',
      value: ' 192.0.2.0/24 ',
      scenario: 'ssh',
      includeShared: true,
    });
    writeActiveDecisionParams(params, f);
    expect(params.toString()).toBe(
      'ip=203.0.113.7&server=lapi-qa&type=captcha&origin=cscli&value=192.0.2.0%2F24&scenario=ssh&shared=1'
    );
    expect(parseActiveDecisionParams(params)).toEqual({ ...f, value: '192.0.2.0/24' });
  });

  it('removes the keys of unset filters', () => {
    const params = new URLSearchParams('server=a&type=ban&shared=1&ip=1.2.3.4');
    writeActiveDecisionParams(params, filters());
    expect(params.toString()).toBe('ip=1.2.3.4');
  });

  it('ignores invalid values', () => {
    expect(
      parseActiveDecisionParams(
        new URLSearchParams('server=../x&type=b%20an&origin=a,b&shared=yes')
      )
    ).toEqual(DEFAULT_ACTIVE_DECISION_FILTERS);
    expect(parseActiveDecisionParams(new URLSearchParams('type=captcha')).type).toBe('captcha');
  });
});

describe('ipOrCidrKind', () => {
  it.each([
    ['203.0.113.7', 'ip'],
    ['0.0.0.0', 'ip'],
    ['2001:db8::1', 'ip'],
    ['::ffff:192.0.2.1', 'ip'],
    ['192.0.2.0/24', 'range'],
    ['192.0.2.0/32', 'range'],
    ['2001:db8::/32', 'range'],
    [' 10.0.0.0/8 ', 'range'],
  ])('%s is a valid %s', (value, kind) => {
    expect(ipOrCidrKind(value)).toBe(kind);
  });

  it.each([
    '',
    '192.0.2',
    '256.1.1.1',
    '01.2.3.4',
    '192.0.2.0/33',
    '192.0.2.0/',
    '192.0.2.0/-1',
    '2001:db8::/129',
    '2001:db8:::1',
    '[::1]',
    'example.com',
    '1.2.3.4/24/1',
  ])('%j is not valid', (value) => {
    expect(ipOrCidrKind(value)).toBeNull();
  });
});

describe('buildActiveDecisionsQuery', () => {
  it('sends nothing for the default filters', () => {
    expect(buildActiveDecisionsQuery(filters()).toString()).toBe('');
  });

  it('maps every filter', () => {
    expect(
      Object.fromEntries(
        buildActiveDecisionsQuery(
          filters({
            server: 'lapi-qa',
            type: 'ban',
            origin: 'crowdsec',
            value: ' 203.0.113.7 ',
            scenario: ' ssh ',
            includeShared: true,
          })
        )
      )
    ).toEqual({
      server: 'lapi-qa',
      type: 'ban',
      origin: 'crowdsec',
      value: '203.0.113.7',
      scenario: 'ssh',
      include_shared: 'true',
    });
  });

  it('leaves an invalid IP filter out', () => {
    expect(buildActiveDecisionsQuery(filters({ value: '192.0.2' })).toString()).toBe('');
  });
});

describe('flattenActiveDecisions', () => {
  const answeredAt = Date.parse('2026-11-11T12:00:00Z');

  it('sorts by expiry, soonest first, never-expiring last', () => {
    const rows = flattenActiveDecisions(
      [
        {
          server: 'b',
          decisions: [
            decision(1, '198.51.100.23', { duration: '24h' }),
            decision(2, '192.0.2.0/28', { duration: '' }),
          ],
        },
        {
          server: 'a',
          decisions: [
            decision(3, '203.0.113.7', { duration: '3h56m24s' }),
            decision(4, '1.2.3.4', { origin: 'CAPI', duration: '12h' }),
          ],
          error: 'ignored here',
        },
      ],
      answeredAt
    );
    expect(rows.map((r) => r.key)).toEqual(['a#3', 'a#4', 'b#1', 'b#2']);
    expect(rows.map((r) => r.shared)).toEqual([false, true, false, false]);
    expect(rows[0].expiry).toEqual({
      kind: 'at',
      date: new Date(answeredAt + (3 * 3600 + 56 * 60 + 24) * 1000),
    });
    expect(rows[3].expiry).toEqual({ kind: 'never' });
  });

  it('orders equal expiries by server, value and id', () => {
    const rows = flattenActiveDecisions(
      [
        { server: 'b', decisions: [decision(1, '1.1.1.1')] },
        { server: 'a', decisions: [decision(3, '2.2.2.2'), decision(2, '1.1.1.1')] },
      ],
      answeredAt
    );
    expect(rows.map((r) => r.key)).toEqual(['a#2', 'a#3', 'b#1']);
  });

  it('recognises the community blocklist origins', () => {
    expect(isSharedOrigin('CAPI')).toBe(true);
    expect(isSharedOrigin('lists')).toBe(true);
    expect(isSharedOrigin('crowdsieve')).toBe(false);
  });
});

describe('paging', () => {
  it('pages by 50 and clamps the page', () => {
    expect(pageWindow(312, 0)).toEqual({ page: 0, pageCount: 7, start: 0, end: 50 });
    expect(pageWindow(312, 6)).toEqual({ page: 6, pageCount: 7, start: 300, end: 312 });
    expect(pageWindow(312, 99).page).toBe(6);
    expect(pageWindow(312, -1).page).toBe(0);
    expect(pageWindow(0, 3)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it('formats the range', () => {
    expect(formatPageRange(pageWindow(312, 0), 312)).toBe('1–50 of 312');
    expect(formatPageRange(pageWindow(312, 6), 312)).toBe('301–312 of 312');
    expect(formatPageRange(pageWindow(0, 0), 0)).toBe('0 of 0');
  });
});

describe('runWithConcurrency', () => {
  it('never runs more tasks than the limit and keeps the order', async () => {
    let running = 0;
    let maxRunning = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5 * (8 - n)));
      running--;
      if (n === 4) throw new Error('four');
      return n * 10;
    });
    expect(maxRunning).toBe(3);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([
      10,
      20,
      30,
      'x',
      50,
      60,
      70,
    ]);
  });

  it('handles an empty list', async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('bulkUnban', () => {
  const targets = [
    { server: 'lapi-qa', id: 1, value: '203.0.113.7' },
    { server: 'lapi-qa', id: 2, value: '198.51.100.23' },
    { server: 'lapi-2', id: 3, value: '192.0.2.0/28' },
  ];

  it('deletes every target with the reason and reports each result', async () => {
    const calls: Array<[number, string]> = [];
    const progress: number[] = [];
    const results = await bulkUnban(
      targets,
      'false positive',
      async (target, reason) => {
        calls.push([target.id, reason]);
        if (target.id === 3) throw new Error('Decision not found');
      },
      2,
      (done) => progress.push(done)
    );
    expect(calls.sort()).toEqual([
      [1, 'false positive'],
      [2, 'false positive'],
      [3, 'false positive'],
    ]);
    expect(progress).toEqual([1, 2, 3]);
    expect(results).toEqual([
      { target: targets[0], ok: true },
      { target: targets[1], ok: true },
      { target: targets[2], ok: false, error: 'Decision not found' },
    ]);
  });
});

describe('summarizeUnbanResults', () => {
  const ok = (id: number): UnbanResult => ({ target: { server: 's', id, value: 'v' }, ok: true });
  const ko = (server: string, error: string): UnbanResult => ({
    target: { server, id: 0, value: 'v' },
    ok: false,
    error,
  });

  it('counts the deleted decisions', () => {
    expect(summarizeUnbanResults([ok(1), ok(2)])).toBe('2 decisions deleted');
    expect(summarizeUnbanResults([ok(1)])).toBe('1 decision deleted');
  });

  it('lists the failures, grouped', () => {
    expect(
      summarizeUnbanResults([
        ok(1),
        ko('lapi-qa', 'Decision not found'),
        ko('lapi-qa', 'Decision not found'),
        ko('lapi-2', 'fetch failed'),
      ])
    ).toBe('1 deleted, 3 failed: lapi-qa: Decision not found (×2); lapi-2: fetch failed');
  });

  it('caps the listed failures', () => {
    const failures = Array.from({ length: 8 }, (_, i) => ko(`s${i}`, 'boom'));
    expect(summarizeUnbanResults(failures)).toBe(
      '0 deleted, 8 failed: s0: boom; s1: boom; s2: boom; s3: boom; s4: boom; and 3 more'
    );
  });
});

describe('makeDeleteDecision', () => {
  it('calls the existing delete route with the decision value and reason', async () => {
    const fetcher = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    await makeDeleteDecision(fetcher)({ server: 'lapi qa', id: 12, value: '192.0.2.0/28' }, 'r');
    expect(fetcher).toHaveBeenCalledWith('/api/decisions/12?server=lapi%20qa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '192.0.2.0/28', reason: 'r' }),
    });
  });

  it('throws the error returned by the route', async () => {
    const del = makeDeleteDecision(
      async () => new Response('{"error":"Decision not found"}', { status: 404 })
    );
    await expect(del({ server: 's', id: 1, value: 'v' }, 'r')).rejects.toThrow(
      'Decision not found'
    );
    const delNoBody = makeDeleteDecision(async () => new Response('oops', { status: 502 }));
    await expect(delNoBody({ server: 's', id: 1, value: 'v' }, 'r')).rejects.toThrow(
      'Failed to delete decision (HTTP 502)'
    );
  });
});

describe('GET /api/decisions/active (dashboard route)', () => {
  const originalEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state.cookies.clear();
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
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

  it('requires a session', async () => {
    process.env = {
      ...originalEnv,
      AUTH_MODE: 'oidc',
      SESSION_SECRET: 'active-decisions-test-secret-0123456789abcdef',
    };
    const res = await activeGet(new NextRequest('http://localhost:3000/api/decisions/active'));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the known filters to the proxy with the API key', async () => {
    process.env = {
      ...originalEnv,
      AUTH_MODE: 'none',
      API_URL: 'http://proxy.test:8080',
      DASHBOARD_API_KEY: 'k',
    };
    const res = await activeGet(
      new NextRequest(
        'http://localhost:3000/api/decisions/active?server=lapi-qa&type=captcha&value=192.0.2.0%2F24&include_shared=true&evil=1&origin='
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://proxy.test:8080/api/decisions/active?server=lapi-qa&type=captcha&value=192.0.2.0%2F24&include_shared=true'
    );
    expect(init.headers).toEqual({ 'X-API-Key': 'k' });
  });

  it('passes the proxy errors through', async () => {
    process.env = { ...originalEnv, AUTH_MODE: 'none' };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'LAPI server not found' }), { status: 404 })
    );
    const res = await activeGet(
      new NextRequest('http://localhost:3000/api/decisions/active?server=nope')
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'LAPI server not found' });
  });

  it('answers 500 when the proxy is unreachable', async () => {
    process.env = { ...originalEnv, AUTH_MODE: 'none' };
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await activeGet(new NextRequest('http://localhost:3000/api/decisions/active'));
    expect(res.status).toBe(500);
  });
});
