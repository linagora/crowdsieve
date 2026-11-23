/**
 * Dashboard side of the audit log: URL state and formatting helpers, CSV
 * encoding, and the session guard of the /api/audit route handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sealData } from 'iron-session';
import {
  DEFAULT_AUDIT_FILTERS,
  auditCsvFilename,
  auditPageCount,
  auditRangeLabel,
  buildAuditApiQuery,
  formatAuditDetails,
  hasActiveAuditFilters,
  parseAuditParams,
  writeAuditParams,
} from '@/lib/auditFilters';
import { auditItemsToCsv, csvCell, toCsv } from '@/lib/auditCsv';
import { parseReturnPath } from '@/lib/alertFilters';
import { manualBanLabel } from '@/lib/alertStatus';

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

import { GET as auditGet } from '../dashboard/app/api/audit/route.js';
import { GET as auditActorsGet } from '../dashboard/app/api/audit/actors/route.js';

describe('audit URL state', () => {
  it('parses filters from the query string', () => {
    expect(
      parseAuditParams(
        new URLSearchParams(
          'user=alice%40example.com&action=ban&ip=198.51.100.244&period=7d&page=3'
        )
      )
    ).toEqual({
      actor: 'alice@example.com',
      action: 'ban',
      ip: '198.51.100.244',
      period: '7d',
      page: 3,
    });
  });

  it('falls back to defaults on unknown values', () => {
    expect(
      parseAuditParams(new URLSearchParams('action=delete&period=1y&page=-2&user=%20&ip='))
    ).toEqual(DEFAULT_AUDIT_FILTERS);
    expect(parseAuditParams(new URLSearchParams('page=1.5')).page).toBe(1);
  });

  it('writes only set filters and keeps unrelated parameters', () => {
    const params = new URLSearchParams('foo=bar&user=old&page=4');
    writeAuditParams(params, { ...DEFAULT_AUDIT_FILTERS, actor: 'bob@example.com', period: '24h' });
    expect(params.toString()).toBe('foo=bar&user=bob%40example.com&period=24h');
  });

  it('round-trips', () => {
    const filters = {
      actor: 'alice@example.com',
      action: 'unban' as const,
      ip: '10.0.0.0/8',
      period: '30d' as const,
      page: 2,
    };
    const params = new URLSearchParams();
    writeAuditParams(params, filters);
    expect(parseAuditParams(params)).toEqual(filters);
  });

  it('tells whether a filter is active (the page is not one)', () => {
    expect(hasActiveAuditFilters(DEFAULT_AUDIT_FILTERS)).toBe(false);
    expect(hasActiveAuditFilters({ ...DEFAULT_AUDIT_FILTERS, page: 3 })).toBe(false);
    expect(hasActiveAuditFilters({ ...DEFAULT_AUDIT_FILTERS, action: 'ban' })).toBe(true);
  });
});

describe('buildAuditApiQuery', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');

  it('maps the filters and the period to the proxy parameters', () => {
    const query = buildAuditApiQuery(
      { actor: 'alice@example.com', action: 'ban', ip: '198.51.100.244', period: '24h', page: 2 },
      now,
      { limit: 50, offset: 50 }
    );
    expect(Object.fromEntries(query)).toEqual({
      actor: 'alice@example.com',
      action: 'ban',
      ip: '198.51.100.244',
      since: '2026-11-22T12:00:00.000Z',
      limit: '50',
      offset: '50',
    });
  });

  it('sends no since for "All" and pins until for the export', () => {
    const query = buildAuditApiQuery(DEFAULT_AUDIT_FILTERS, now, {
      limit: 1000,
      offset: 0,
      until: now,
    });
    expect(Object.fromEntries(query)).toEqual({
      until: '2026-11-23T12:00:00.000Z',
      limit: '1000',
      offset: '0',
    });
  });

  it('computes 7d and 30d periods', () => {
    const since = (period: '7d' | '30d') =>
      buildAuditApiQuery({ ...DEFAULT_AUDIT_FILTERS, period }, now, { limit: 1, offset: 0 }).get(
        'since'
      );
    expect(since('7d')).toBe('2026-11-16T12:00:00.000Z');
    expect(since('30d')).toBe('2026-10-24T12:00:00.000Z');
  });
});

describe('audit formatting', () => {
  it('formats the details of a ban', () => {
    expect(formatAuditDetails({ type: 'captcha', duration: '2h' })).toBe('captcha · 2h');
    expect(formatAuditDetails({ type: 'ban', duration: '1h' })).toBe('ban · 1h');
    expect(formatAuditDetails({ type: null, duration: null })).toBe('');
  });

  it('formats the range of the current page', () => {
    expect(auditRangeLabel(0, 50, 132)).toBe('1–50 of 132');
    expect(auditRangeLabel(100, 32, 132)).toBe('101–132 of 132');
    expect(auditRangeLabel(0, 0, 0)).toBe('0 of 0');
    expect(auditPageCount(132)).toBe(3);
    expect(auditPageCount(0)).toBe(1);
  });

  it('names the CSV file after the local date and time', () => {
    expect(auditCsvFilename(new Date(2026, 0, 5, 7, 3))).toBe('crowdsieve-audit-20260105-0703.csv');
  });

  it('links audit rows back to the audit log', () => {
    expect(parseReturnPath('/audit?user=alice%40example.com')).toEqual({
      href: '/audit?user=alice%40example.com',
      label: 'Audit log',
    });
  });

  it('labels manual-ban badges with the remediation type', () => {
    expect(manualBanLabel({ auditType: 'captcha' })).toBe('Manual captcha');
    expect(manualBanLabel({ auditType: 'ban' })).toBe('Manual ban');
    expect(manualBanLabel({ auditType: null })).toBe('Manual ban');
    expect(manualBanLabel({})).toBe('Manual ban');
  });
});

describe('audit CSV', () => {
  it('quotes cells as RFC 4180 requires', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe('"\'\rx"');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('::1')).toBe('::1');
  });

  it('joins rows with CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c,d', null],
      ])
    ).toBe('a,b\r\n"c,d",\r\n');
  });

  it('exports every audit field', () => {
    const csv = auditItemsToCsv([
      {
        id: 7,
        at: '2026-11-20T10:00:00.000Z',
        action: 'ban',
        actor: 'alice@example.com',
        ip: '198.51.100.244',
        server: 'lapi-qa',
        type: 'ban',
        duration: '1h',
        reason: 'abuse, see #42',
      },
      {
        id: 8,
        at: '2026-11-20T11:00:00.000Z',
        action: 'unban',
        actor: null,
        ip: '198.51.100.244',
        server: 'lapi-qa',
        type: null,
        duration: null,
        reason: '=cmd',
      },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'id,at,user,action,ip,server,type,duration,reason',
      '7,2026-11-20T10:00:00.000Z,alice@example.com,ban,198.51.100.244,lapi-qa,ban,1h,"abuse, see #42"',
      "8,2026-11-20T11:00:00.000Z,,unban,198.51.100.244,lapi-qa,,,'=cmd",
      '',
    ]);
  });
});

describe('/api/audit route handlers', () => {
  const originalEnv = { ...process.env };
  const SESSION_SECRET = 'audit-test-session-secret-0123456789abcdef';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AUTH_MODE: 'oidc',
      SESSION_SECRET,
      DASHBOARD_API_KEY: 'k',
      API_URL: 'http://proxy.test',
    };
    state.cookies.clear();
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], total: 0, actors: [] }), {
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

  async function signIn() {
    state.cookies.set(
      'crowdsieve-session',
      await sealData(
        {
          user: { sub: 'u1', email: 'alice@example.com' },
          expiresAt: Date.now() + 3600_000,
          sid: `sid-${Math.random()}`,
        },
        { password: SESSION_SECRET }
      )
    );
  }

  it('GET /api/audit requires a session', async () => {
    const res = await auditGet(new NextRequest('http://localhost:3000/api/audit'));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/audit/actors requires a session', async () => {
    const res = await auditActorsGet();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the audit parameters to the proxy, with the API key', async () => {
    await signIn();
    const res = await auditGet(
      new NextRequest(
        'http://localhost:3000/api/audit?actor=alice%40example.com&action=ban&ip=10.0.0.0%2F8&limit=50&offset=0&scenario=x&filtered=true'
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0, actors: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = new URL(url);
    expect(forwarded.origin + forwarded.pathname).toBe('http://proxy.test/api/audit');
    expect(Object.fromEntries(forwarded.searchParams)).toEqual({
      actor: 'alice@example.com',
      action: 'ban',
      ip: '10.0.0.0/8',
      limit: '50',
      offset: '0',
    });
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
  });

  it('passes validation errors of the proxy through, hides the others', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid IP address or CIDR format' }), { status: 400 })
    );
    let res = await auditGet(new NextRequest('http://localhost:3000/api/audit?ip=foo'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid IP address or CIDR format' });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );
    res = await auditGet(new NextRequest('http://localhost:3000/api/audit'));
    expect(res.status).toBe(502);
  });

  it('GET /api/audit/actors proxies the actor list', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ actors: ['alice@example.com'] }), { status: 200 })
    );
    const res = await auditActorsGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actors: ['alice@example.com'] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://proxy.test/api/audit/actors');
  });
});
