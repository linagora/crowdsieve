/**
 * Read-only access for users outside the operator groups (#132).
 *
 * `AUTH_OPERATOR_GROUPS` lists the groups whose members may write (ban,
 * unban, run analyzers). Everyone else is a Viewer, refused with 403 by every
 * dashboard write route. Unset, everyone is an Operator as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sealData, unsealData } from 'iron-session';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined,
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => state.headers),
}));

const oidc = vi.hoisted(() => ({
  authorizationCodeGrant: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

vi.mock('openid-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('openid-client')>()),
  authorizationCodeGrant: oidc.authorizationCodeGrant,
  fetchUserInfo: oidc.fetchUserInfo,
}));

vi.mock('@/lib/oidc/client', () => ({
  getOidcClient: vi.fn(async () => ({ mocked: true })),
}));

import { POST as banPost } from '../dashboard/app/api/decisions/ban/route.js';
import { DELETE as decisionDelete } from '../dashboard/app/api/decisions/[id]/route.js';
import { POST as analyzerRunPost } from '../dashboard/app/api/analyzers/[id]/run/route.js';
import { POST as filterTestPost } from '../dashboard/app/api/filters/test/route.js';
import { GET as alertsGet } from '../dashboard/app/api/alerts/route.js';
import { GET as statusGet } from '../dashboard/app/api/status/route.js';
import { GET as sessionGet } from '../dashboard/app/api/auth/session/route.js';
import { GET as callbackGet } from '../dashboard/app/api/auth/callback/route.js';
import { requireOperator } from '../dashboard/lib/auth/guard.js';
import { getSessionRole } from '../dashboard/lib/oidc/session.js';
import { getOidcScopes } from '../dashboard/lib/oidc/config.js';
import { checkAuthConfiguration } from '../dashboard/lib/auth/startup.js';
import { fetchWithAuth } from '../dashboard/lib/fetchWithAuth.js';
import {
  READ_ONLY_ERROR,
  getGroupsClaim,
  getGroupsHeader,
  getOperatorGroups,
  isRoleEnforced,
  matchOperatorGroups,
  parseGroupList,
  readClaim,
  resolveSignInRole,
  roleForGroups,
  roleFromHeaders,
  roleFromSession,
  roleLabel,
} from '../dashboard/lib/auth/roles.js';

const originalEnv = { ...process.env };
const SESSION_SECRET = 'roles-test-session-secret-0123456789abcdef';
const PROXY_SECRET = 'proxy-secret-0123456789abcdef0123456789';

let fetchMock: ReturnType<typeof vi.fn>;

async function setSessionCookie(data: Record<string, unknown>): Promise<void> {
  state.cookies.set('crowdsieve-session', await sealData(data, { password: SESSION_SECRET }));
}

function liveSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { sub: 'bob', email: 'bob@example.com' },
    expiresAt: Date.now() + 3600_000,
    sid: `sid-${Math.random()}`,
    ...overrides,
  };
}

const operatorSession = () =>
  liveSession({ user: { sub: 'alice' }, role: 'operator', operatorGroups: ['secops'] });
const viewerSession = () => liveSession({ role: 'viewer', operatorGroups: [] });

const json = { 'content-type': 'application/json' };

/** The three write routes of the dashboard, as a browser would call them. */
const WRITE_ROUTES: Array<[string, () => Promise<Response>]> = [
  [
    'POST /api/decisions/ban',
    () =>
      banPost(
        new NextRequest('http://localhost:3000/api/decisions/ban', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ server: 'lapi', ip: '192.0.2.1', duration: '4h', reason: 'x' }),
        })
      ),
  ],
  [
    'DELETE /api/decisions/:id',
    () =>
      decisionDelete(
        new NextRequest('http://localhost:3000/api/decisions/1?server=lapi', {
          method: 'DELETE',
          headers: json,
          body: JSON.stringify({ ip: '192.0.2.1', reason: 'x' }),
        }),
        { params: Promise.resolve({ id: '1' }) }
      ),
  ],
  [
    'POST /api/analyzers/:id/run',
    () =>
      analyzerRunPost(
        new NextRequest('http://localhost:3000/api/analyzers/a/run', {
          method: 'POST',
          headers: json,
          body: '{}',
        }),
        { params: Promise.resolve({ id: 'a' }) }
      ),
  ],
];

beforeEach(() => {
  process.env = {
    ...originalEnv,
    AUTH_MODE: 'oidc',
    SESSION_SECRET,
    DASHBOARD_API_KEY: 'k',
  };
  delete process.env.AUTH_OPERATOR_GROUPS;
  delete process.env.OIDC_GROUPS_CLAIM;
  delete process.env.AUTH_GROUPS_HEADER;
  delete process.env.OIDC_SCOPES;
  state.cookies.clear();
  state.headers = new Headers();
  oidc.authorizationCodeGrant.mockReset();
  oidc.fetchUserInfo.mockReset();
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

describe('role helpers', () => {
  it('parses AUTH_OPERATOR_GROUPS', () => {
    expect(getOperatorGroups({})).toEqual([]);
    expect(getOperatorGroups({ AUTH_OPERATOR_GROUPS: '  ' })).toEqual([]);
    expect(getOperatorGroups({ AUTH_OPERATOR_GROUPS: ' secops, ,admins,secops ' })).toEqual([
      'secops',
      'admins',
    ]);
    expect(isRoleEnforced({})).toBe(false);
    expect(isRoleEnforced({ AUTH_OPERATOR_GROUPS: 'secops' })).toBe(true);
  });

  it('reads the claim and header names with their defaults', () => {
    expect(getGroupsClaim({})).toBe('groups');
    expect(getGroupsClaim({ OIDC_GROUPS_CLAIM: ' roles ' })).toBe('roles');
    expect(getGroupsHeader({})).toBe('x-forwarded-groups');
    expect(getGroupsHeader({ AUTH_GROUPS_HEADER: 'Remote-Groups' })).toBe('remote-groups');
  });

  it('parses group lists from strings and arrays', () => {
    expect(parseGroupList('secops, dev')).toEqual(['secops', 'dev']);
    // LemonLDAP::NG $groups
    expect(parseGroupList('secops; dev')).toEqual(['secops', 'dev']);
    // authentik X-authentik-groups
    expect(parseGroupList('secops|dev')).toEqual(['secops', 'dev']);
    expect(parseGroupList(['cn=secops,ou=groups', ' dev ', 42, ''])).toEqual([
      'cn=secops,ou=groups',
      'dev',
    ]);
    expect(parseGroupList(undefined)).toEqual([]);
    expect(parseGroupList(null)).toEqual([]);
    expect(parseGroupList({ secops: true })).toEqual([]);
    expect(parseGroupList('sec\r\nops')).toEqual(['secops']);
  });

  it('reads exact, namespaced and nested claims', () => {
    const claims = {
      groups: ['a'],
      'https://example.com/groups': ['b'],
      realm_access: { roles: ['c'] },
    };
    expect(readClaim(claims, 'groups')).toEqual(['a']);
    expect(readClaim(claims, 'https://example.com/groups')).toEqual(['b']);
    expect(readClaim(claims, 'realm_access.roles')).toEqual(['c']);
    expect(readClaim(claims, 'realm_access.missing')).toBeUndefined();
    expect(readClaim(claims, 'missing')).toBeUndefined();
    expect(readClaim(claims, '__proto__.toString')).toBeUndefined();
  });

  it('maps groups to a role', () => {
    const env = { AUTH_OPERATOR_GROUPS: 'secops,admins' };
    expect(roleForGroups([], {})).toBe('operator');
    expect(roleForGroups(['dev'], env)).toBe('viewer');
    expect(roleForGroups(['dev', 'admins'], env)).toBe('operator');
    // Group names are case-sensitive.
    expect(roleForGroups(['SecOps'], env)).toBe('viewer');
    expect(matchOperatorGroups(['dev', 'secops', 'secops'], env)).toEqual(['secops']);
  });

  it('labels roles for the user menu', () => {
    expect(roleLabel('operator')).toBe('Operator');
    expect(roleLabel('viewer')).toBe('Viewer (read-only)');
    expect(roleLabel(null)).toBeNull();
  });

  it('reads the role stored in a session', () => {
    const env = { AUTH_OPERATOR_GROUPS: 'secops' };
    expect(roleFromSession({ role: 'operator', operatorGroups: ['secops'] }, env)).toBe('operator');
    expect(roleFromSession({ role: 'viewer', operatorGroups: [] }, env)).toBe('viewer');
    // Session sealed before roles existed: Viewer until the next sign-in...
    expect(roleFromSession({}, env)).toBe('viewer');
    // ...unless roles are not enforced.
    expect(roleFromSession({}, {})).toBe('operator');
    expect(roleFromSession({ role: 'viewer' }, {})).toBe('operator');
    // The group that granted the role is no longer an operator group.
    expect(
      roleFromSession(
        { role: 'operator', operatorGroups: ['secops'] },
        { AUTH_OPERATOR_GROUPS: 'x' }
      )
    ).toBe('viewer');
    // A role without the groups that granted it is not trusted.
    expect(roleFromSession({ role: 'operator' }, env)).toBe('viewer');
  });

  it('reads the role from the groups header', () => {
    const env = { AUTH_OPERATOR_GROUPS: 'secops' };
    expect(roleFromHeaders(new Headers({ 'X-Forwarded-Groups': 'dev,secops' }), env)).toBe(
      'operator'
    );
    expect(roleFromHeaders(new Headers({ 'X-Forwarded-Groups': 'dev' }), env)).toBe('viewer');
    expect(roleFromHeaders(new Headers(), env)).toBe('viewer');
    expect(roleFromHeaders(new Headers(), {})).toBe('operator');
    expect(
      roleFromHeaders(new Headers({ 'Remote-Groups': 'secops' }), {
        ...env,
        AUTH_GROUPS_HEADER: 'Remote-Groups',
      })
    ).toBe('operator');
  });

  it('builds the OIDC scopes', () => {
    expect(getOidcScopes({})).toBe('openid email profile');
    expect(getOidcScopes({ OIDC_SCOPES: 'openid email profile groups' })).toBe(
      'openid email profile groups'
    );
    expect(getOidcScopes({ OIDC_SCOPES: 'email,groups' })).toBe('openid email groups');
  });
});

describe('resolveSignInRole', () => {
  const env = { AUTH_OPERATOR_GROUPS: 'secops' };

  it('does not need groups nor userinfo when roles are not enforced', async () => {
    const loadUserInfo = vi.fn();
    expect(await resolveSignInRole({ sub: 'a' }, loadUserInfo, {})).toEqual({
      role: 'operator',
      operatorGroups: [],
    });
    expect(loadUserInfo).not.toHaveBeenCalled();
  });

  it('uses the groups claim of the ID token', async () => {
    const loadUserInfo = vi.fn();
    expect(await resolveSignInRole({ groups: ['secops', 'dev'] }, loadUserInfo, env)).toEqual({
      role: 'operator',
      operatorGroups: ['secops'],
    });
    expect(await resolveSignInRole({ groups: [] }, loadUserInfo, env)).toEqual({
      role: 'viewer',
      operatorGroups: [],
    });
    // An empty claim in the ID token is an answer: no userinfo request.
    expect(loadUserInfo).not.toHaveBeenCalled();
  });

  it('falls back to userinfo when the ID token has no groups claim', async () => {
    const loadUserInfo = vi.fn(async () => ({ sub: 'a', roles: 'secops' }));
    expect(
      await resolveSignInRole({ sub: 'a' }, loadUserInfo, { ...env, OIDC_GROUPS_CLAIM: 'roles' })
    ).toEqual({ role: 'operator', operatorGroups: ['secops'] });
    expect(loadUserInfo).toHaveBeenCalledTimes(1);
  });

  it('signs the user in as a Viewer when userinfo fails', async () => {
    const loadUserInfo = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await resolveSignInRole({ sub: 'a' }, loadUserInfo, env)).toEqual({
      role: 'viewer',
      operatorGroups: [],
    });
  });
});

describe('write routes with AUTH_OPERATOR_GROUPS unset', () => {
  it.each(WRITE_ROUTES)('%s works for every signed-in user, as before', async (_, call) => {
    // Old session, sealed without a role.
    await setSessionCookie(liveSession());
    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('write routes in OIDC mode with AUTH_OPERATOR_GROUPS=secops', () => {
  beforeEach(() => {
    process.env.AUTH_OPERATOR_GROUPS = 'secops';
  });

  it.each(WRITE_ROUTES)('%s answers 403 to a Viewer, before calling the proxy', async (_, call) => {
    await setSessionCookie(viewerSession());
    const res = await call();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(WRITE_ROUTES)('%s lets an Operator through', async (_, call) => {
    await setSessionCookie(operatorSession());
    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(WRITE_ROUTES)(
    '%s treats a session sealed without a role as a Viewer',
    async (_, call) => {
      await setSessionCookie(liveSession());
      const res = await call();

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(WRITE_ROUTES)('%s still answers 401 without a session', async (_, call) => {
    const res = await call();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('demotes an Operator whose group is removed from AUTH_OPERATOR_GROUPS', async () => {
    await setSessionCookie(operatorSession());
    process.env.AUTH_OPERATOR_GROUPS = 'admins';

    expect((await WRITE_ROUTES[0][1]()).status).toBe(403);
  });

  it('records the Operator as actor', async () => {
    await setSessionCookie(operatorSession());
    await WRITE_ROUTES[0][1]();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Crowdsieve-Actor']).toBe('alice');
  });

  it('lets a Viewer read alerts and the status, and test filters', async () => {
    await setSessionCookie(viewerSession());

    expect((await alertsGet(new NextRequest('http://localhost:3000/api/alerts'))).status).toBe(200);
    expect((await statusGet()).status).toBe(200);
    const res = await filterTestPost(
      new NextRequest('http://localhost:3000/api/filters/test', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ alertId: 1 }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('reports the role through /api/auth/session', async () => {
    await setSessionCookie(viewerSession());
    expect((await (await sessionGet()).json()).role).toBe('viewer');

    await setSessionCookie(operatorSession());
    expect((await (await sessionGet()).json()).role).toBe('operator');

    state.cookies.clear();
    const body = await (await sessionGet()).json();
    expect(body.authenticated).toBe(false);
    expect(body.role).toBeNull();
  });

  it('getSessionRole() gives Viewer without a live session', async () => {
    expect(await getSessionRole()).toBe('viewer');
    await setSessionCookie(operatorSession());
    expect(await getSessionRole()).toBe('operator');
    await setSessionCookie(operatorSession());
    state.cookies.set('crowdsieve-session', 'garbage');
    expect(await getSessionRole()).toBe('viewer');
  });

  it('requireOperator() is reusable by any write route', async () => {
    await setSessionCookie(viewerSession());
    const denied = await requireOperator();
    expect(denied?.status).toBe(403);

    await setSessionCookie(operatorSession());
    expect(await requireOperator()).toBeNull();
  });
});

describe('write routes in headers mode with AUTH_OPERATOR_GROUPS=secops', () => {
  beforeEach(() => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_OPERATOR_GROUPS = 'secops';
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
  });

  function proxyHeaders(extra: Record<string, string> = {}): Headers {
    return new Headers({ 'Auth-Sub': 'bob', 'X-Auth-Proxy-Secret': PROXY_SECRET, ...extra });
  }

  it.each(WRITE_ROUTES)('%s follows the groups header on each request', async (_, call) => {
    state.headers = proxyHeaders({ 'X-Forwarded-Groups': 'dev, secops' });
    expect((await call()).status).toBe(200);

    state.headers = proxyHeaders({ 'X-Forwarded-Groups': 'dev' });
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_ERROR });

    state.headers = proxyHeaders();
    expect((await call()).status).toBe(403);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the header named by AUTH_GROUPS_HEADER', async () => {
    process.env.AUTH_GROUPS_HEADER = 'Auth-Groups';
    state.headers = proxyHeaders({ 'X-Forwarded-Groups': 'secops' });
    expect((await WRITE_ROUTES[0][1]()).status).toBe(403);

    state.headers = proxyHeaders({ 'Auth-Groups': 'secops' });
    expect((await WRITE_ROUTES[0][1]()).status).toBe(200);
  });

  it('rejects a spoofed groups header without the proxy secret', async () => {
    state.headers = new Headers({
      'Auth-Sub': 'mallory',
      'X-Forwarded-Groups': 'secops',
      'X-Auth-Proxy-Secret': 'guess',
    });
    const res = await WRITE_ROUTES[0][1]();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getSessionRole()).toBe('viewer');
  });

  it('ignores role-like Auth-* claims', async () => {
    state.headers = proxyHeaders({ 'Auth-Role': 'operator', 'Auth-Groups': 'secops' });
    expect((await WRITE_ROUTES[0][1]()).status).toBe(403);

    const body = await (await sessionGet()).json();
    expect(body.role).toBe('viewer');
    expect(body.user.role).toBe('operator'); // a display claim, never used for access
  });

  it('reports the role through /api/auth/session', async () => {
    state.headers = proxyHeaders({ 'X-Forwarded-Groups': 'secops' });
    expect((await (await sessionGet()).json()).role).toBe('operator');
  });

  it('lets everyone write when AUTH_OPERATOR_GROUPS is unset', async () => {
    delete process.env.AUTH_OPERATOR_GROUPS;
    state.headers = proxyHeaders();
    expect((await WRITE_ROUTES[0][1]()).status).toBe(200);
  });
});

describe('none mode', () => {
  it('everyone is an Operator, even with AUTH_OPERATOR_GROUPS set', async () => {
    process.env.AUTH_MODE = 'none';
    process.env.AUTH_OPERATOR_GROUPS = 'secops';

    for (const [, call] of WRITE_ROUTES) {
      expect((await call()).status).toBe(200);
    }
    expect((await (await sessionGet()).json()).role).toBe('operator');
  });
});

describe('OIDC callback stores the role in the sealed session', () => {
  beforeEach(async () => {
    process.env.OIDC_ISSUER = 'https://dex.example.com';
    process.env.OIDC_CLIENT_ID = 'crowdsieve';
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    process.env.AUTH_OPERATOR_GROUPS = 'secops';
    await setSessionCookie({ state: 's', nonce: 'n', codeVerifier: 'v' });
  });

  function tokens(claims: Record<string, unknown>) {
    return {
      access_token: 'at',
      id_token: 'it',
      claims: () => ({ sub: 'alice', ...claims }),
      expiresIn: () => 3600,
    };
  }

  async function signIn(): Promise<Record<string, unknown>> {
    const res = await callbackGet(
      new NextRequest('http://localhost:3000/api/auth/callback?code=c&state=s')
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).not.toContain('error');
    return unsealData(state.cookies.get('crowdsieve-session')!, { password: SESSION_SECRET });
  }

  it('stores Operator for a member of secops (ID token groups)', async () => {
    oidc.authorizationCodeGrant.mockResolvedValue(tokens({ groups: ['secops'] }));
    const session = await signIn();

    expect(session.role).toBe('operator');
    expect(session.operatorGroups).toEqual(['secops']);
    expect(oidc.fetchUserInfo).not.toHaveBeenCalled();
    expect(await getSessionRole()).toBe('operator');
  });

  it('stores Viewer for a user outside secops', async () => {
    oidc.authorizationCodeGrant.mockResolvedValue(tokens({ groups: ['dev'] }));
    const session = await signIn();

    expect(session.role).toBe('viewer');
    expect(await getSessionRole()).toBe('viewer');
  });

  it('reads the groups from userinfo when the ID token has none', async () => {
    oidc.authorizationCodeGrant.mockResolvedValue(tokens({}));
    oidc.fetchUserInfo.mockResolvedValue({ sub: 'alice', groups: ['secops'] });
    const session = await signIn();

    expect(oidc.fetchUserInfo).toHaveBeenCalledWith({ mocked: true }, 'at', 'alice');
    expect(session.role).toBe('operator');
  });

  it('stores Operator without reading groups when roles are not enforced', async () => {
    delete process.env.AUTH_OPERATOR_GROUPS;
    oidc.authorizationCodeGrant.mockResolvedValue(tokens({}));
    const session = await signIn();

    expect(session.role).toBe('operator');
    expect(oidc.fetchUserInfo).not.toHaveBeenCalled();
  });
});

describe('fetchWithAuth', () => {
  it('hands the read-only refusal to the caller instead of the session-expired overlay', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: READ_ONLY_ERROR }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await fetchWithAuth('/api/decisions/ban', { method: 'POST' });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(READ_ONLY_ERROR);
  });
});

describe('every dashboard write route requires the Operator role', () => {
  // POST routes that change nothing (they only take a JSON body), open to Viewers.
  const READ_ONLY_POSTS = new Set(['filters/test/route.ts']);

  function routeFiles(dir: string, base = dir): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(path, base);
      return entry.name === 'route.ts' ? [relative(base, path)] : [];
    });
  }

  it('uses requireOperator() in each POST/PUT/PATCH/DELETE handler outside api/auth', () => {
    const apiDir = fileURLToPath(new URL('../dashboard/app/api', import.meta.url));
    const writeRoutes = routeFiles(apiDir)
      .filter((file) => !file.startsWith('auth/'))
      .filter((file) =>
        /export async function (POST|PUT|PATCH|DELETE)\b/.test(
          readFileSync(join(apiDir, file), 'utf8')
        )
      );

    expect(writeRoutes.length).toBeGreaterThanOrEqual(3);
    for (const file of writeRoutes) {
      if (READ_ONLY_POSTS.has(file)) continue;
      expect(readFileSync(join(apiDir, file), 'utf8'), file).toMatch(/await requireOperator\(\)/);
    }
  });
});

describe('startup logging', () => {
  it('warns that the groups header must be set by the proxy', () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_PROXY_SECRET = PROXY_SECRET;
    process.env.AUTH_OPERATOR_GROUPS = 'secops';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    checkAuthConfiguration();

    expect(info.mock.calls.flat().join('\n')).toMatch(/x-forwarded-groups header on every request/);
  });

  it('says AUTH_OPERATOR_GROUPS is ignored without authentication', () => {
    process.env.AUTH_MODE = 'none';
    process.env.AUTH_OPERATOR_GROUPS = 'secops';
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkAuthConfiguration();

    expect(warn.mock.calls.flat().join('\n')).toMatch(/AUTH_OPERATOR_GROUPS is ignored/);
  });
});
