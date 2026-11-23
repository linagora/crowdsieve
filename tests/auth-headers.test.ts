import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalEnv = process.env;

// next/headers is not used by the auth modules under test, but mock it for
// safety in case any transitive import resolves through Next.
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(() => new Headers()),
}));

describe('parseAuthHeaders', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when Auth-Sub is absent', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({ 'Auth-Email': 'alice@example.com' });
    expect(parseAuthHeaders(headers)).toBeNull();
  });

  it('returns null when Auth-Sub is empty', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({ 'Auth-Sub': '' });
    expect(parseAuthHeaders(headers)).toBeNull();
  });

  it('returns null when Auth-Sub is whitespace only', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({ 'Auth-Sub': '   ' });
    expect(parseAuthHeaders(headers)).toBeNull();
  });

  it('returns SessionUser with sub for minimal headers', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({ 'Auth-Sub': 'user-1' });
    expect(parseAuthHeaders(headers)).toEqual({ sub: 'user-1' });
  });

  it('maps known fields (sub/email/name/picture)', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': 'user-1',
      'Auth-Email': 'alice@example.com',
      'Auth-Name': 'Alice',
      'Auth-Picture': 'https://example.com/avatar.png',
    });
    expect(parseAuthHeaders(headers)).toEqual({
      sub: 'user-1',
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://example.com/avatar.png',
    });
  });

  it('maps Auth-Family-Name to familyName and Auth-Given-Name to givenName', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': 'user-1',
      'Auth-Family-Name': 'Doe',
      'Auth-Given-Name': 'Jane',
    });
    const user = parseAuthHeaders(headers);
    expect(user).toMatchObject({
      sub: 'user-1',
      familyName: 'Doe',
      givenName: 'Jane',
    });
  });

  it('maps multi-segment headers correctly (Auth-Preferred-Username)', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': 'user-1',
      'Auth-Preferred-Username': 'jdoe',
    });
    const user = parseAuthHeaders(headers);
    expect(user).toMatchObject({
      sub: 'user-1',
      preferredUsername: 'jdoe',
    });
  });

  it('strips CR/LF from header values (defense in depth)', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    // Manually pass a record because Headers may reject CR/LF.
    const user = parseAuthHeaders({
      'auth-sub': 'user-1',
      'auth-name': 'Alice\r\nInjected',
    });
    expect(user).toEqual({ sub: 'user-1', name: 'AliceInjected' });
  });

  it('truncates very long values to 1024 chars', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const long = 'a'.repeat(2000);
    const user = parseAuthHeaders({
      'auth-sub': 'user-1',
      'auth-name': long,
    });
    expect(user?.name?.length).toBe(1024);
  });

  it('rejects non-http(s) Auth-Picture URLs', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': 'user-1',
      'Auth-Picture': 'javascript:alert(1)',
    });
    const user = parseAuthHeaders(headers);
    expect(user).toEqual({ sub: 'user-1' });
    expect(user?.picture).toBeUndefined();
  });

  it('accepts http (not just https) Auth-Picture URLs', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': 'user-1',
      'Auth-Picture': 'http://example.com/a.png',
    });
    expect(parseAuthHeaders(headers)?.picture).toBe('http://example.com/a.png');
  });

  it('skips bare prefix headers (Auth-)', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const user = parseAuthHeaders({
      'auth-sub': 'user-1',
      'auth-': 'should-be-ignored',
    });
    expect(user).toEqual({ sub: 'user-1' });
  });

  it('trims leading/trailing whitespace from values', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const headers = new Headers({
      'Auth-Sub': '  user-1  ',
      'Auth-Name': '  Alice  ',
    });
    expect(parseAuthHeaders(headers)).toEqual({ sub: 'user-1', name: 'Alice' });
  });

  it('accepts a plain Record<string, string> as input', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const user = parseAuthHeaders({
      'auth-sub': 'user-1',
      'auth-email': 'alice@example.com',
    });
    expect(user).toEqual({ sub: 'user-1', email: 'alice@example.com' });
  });
});

describe('getAuthMode', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AUTH_MODE;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to "none" when nothing is configured', async () => {
    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('none');
  });

  it('defaults to "oidc" when OIDC_ISSUER and OIDC_CLIENT_ID are set', async () => {
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('oidc');
  });

  it('explicit AUTH_MODE=headers wins over OIDC env vars', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('headers');
  });

  it('explicit AUTH_MODE=oidc works without OIDC_ISSUER', async () => {
    process.env.AUTH_MODE = 'oidc';
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('oidc');
  });

  it('explicit AUTH_MODE=none disables auth', async () => {
    process.env.AUTH_MODE = 'none';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('none');
  });

  it('AUTH_MODE is case-insensitive and trimmed', async () => {
    process.env.AUTH_MODE = '  HEADERS  ';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('headers');
  });

  it('unknown AUTH_MODE values fall back to auto-detect', async () => {
    process.env.AUTH_MODE = 'invalid';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'my-client';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('oidc');
  });

  it('auto-detect treats whitespace-only OIDC env vars as unset', async () => {
    delete process.env.AUTH_MODE;
    process.env.OIDC_ISSUER = '   ';
    process.env.OIDC_CLIENT_ID = 'my-client';

    const { getAuthMode } = await import('../dashboard/lib/auth/mode.js');
    expect(getAuthMode()).toBe('none');
  });

  it('isAuthModeExplicit is true only for a supported AUTH_MODE value', async () => {
    const { isAuthModeExplicit } = await import('../dashboard/lib/auth/mode.js');
    expect(isAuthModeExplicit()).toBe(false);
    process.env.AUTH_MODE = 'None';
    expect(isAuthModeExplicit()).toBe(true);
    process.env.AUTH_MODE = 'invalid';
    expect(isAuthModeExplicit()).toBe(false);
  });

  it('isHeadersAuthEnabled mirrors getAuthMode', async () => {
    process.env.AUTH_MODE = 'headers';
    const { isHeadersAuthEnabled } = await import('../dashboard/lib/auth/mode.js');
    expect(isHeadersAuthEnabled()).toBe(true);
  });
});

describe('isTrustedProxy', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.TRUSTED_PROXY_IPS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true when the trust list is empty (no check configured)', async () => {
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('1.2.3.4')).toBe(true);
    expect(isTrustedProxy(null)).toBe(true);
  });

  it('returns false for null clientIp when a trust list is configured', async () => {
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy(null)).toBe(false);
  });

  it('matches an exact IPv4 address', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.1, 192.168.1.1';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('192.168.1.1')).toBe(true);
    expect(isTrustedProxy('10.0.0.1')).toBe(true);
    expect(isTrustedProxy('192.168.1.2')).toBe(false);
  });

  it('matches an exact IPv6 address (case-insensitive)', async () => {
    process.env.TRUSTED_PROXY_IPS = '2001:db8::1';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('2001:db8::1')).toBe(true);
    expect(isTrustedProxy('2001:DB8::1')).toBe(true);
    expect(isTrustedProxy('2001:db8::2')).toBe(false);
  });

  it('matches IPv4 CIDR ranges', async () => {
    process.env.TRUSTED_PROXY_IPS = '192.168.0.0/16';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('192.168.1.1')).toBe(true);
    expect(isTrustedProxy('192.168.250.99')).toBe(true);
    expect(isTrustedProxy('192.169.0.1')).toBe(false);
    expect(isTrustedProxy('10.0.0.1')).toBe(false);
  });

  it('handles /32 (single host) CIDR correctly', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.42/32';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('10.0.0.42')).toBe(true);
    expect(isTrustedProxy('10.0.0.43')).toBe(false);
  });

  it('handles /0 (everything) CIDR correctly', async () => {
    process.env.TRUSTED_PROXY_IPS = '0.0.0.0/0';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('1.2.3.4')).toBe(true);
    expect(isTrustedProxy('255.255.255.255')).toBe(true);
  });

  it('rejects malformed entries gracefully', async () => {
    process.env.TRUSTED_PROXY_IPS = 'not-an-ip, 192.168.1.999, 10.0.0.0/99';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('192.168.1.1')).toBe(false);
  });

  it('matches IPv4-mapped IPv6 addresses against IPv4 entries', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.1';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('::ffff:10.0.0.1')).toBe(true);
  });

  it('matches an exact IPv6 / IPv4-mapped entry whatever its spelling', async () => {
    process.env.TRUSTED_PROXY_IPS = '0:0:0:0:0:0:0:1, [0:0:0:0:0:ffff:10.0.0.1], ::ffff:c0a8:10a';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('::1')).toBe(true);
    expect(isTrustedProxy('::0001')).toBe(true);
    expect(isTrustedProxy('10.0.0.1')).toBe(true);
    expect(isTrustedProxy('::ffff:10.0.0.1')).toBe(true);
    expect(isTrustedProxy('192.168.1.10')).toBe(true);
    expect(isTrustedProxy('::2')).toBe(false);
    expect(isTrustedProxy('10.0.0.2')).toBe(false);
  });

  it('rejects IPv4 client addresses with leading-zero octets', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';
    const { isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(isTrustedProxy('10.0.0.1')).toBe(true);
    expect(isTrustedProxy('010.0.0.1')).toBe(false);
    expect(isTrustedProxy('10.0.0.01')).toBe(false);
    expect(isTrustedProxy('10.00.0.1')).toBe(false);
  });

  it('drops empty entries from the comma-separated list', async () => {
    process.env.TRUSTED_PROXY_IPS = ',10.0.0.1,,, 10.0.0.2,';
    const { getTrustedProxyIps, isTrustedProxy } = await import('../dashboard/lib/auth/trust.js');
    expect(getTrustedProxyIps()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(isTrustedProxy('10.0.0.1')).toBe(true);
    expect(isTrustedProxy('10.0.0.2')).toBe(true);
  });
});

describe('getClientIp', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the right-most X-Forwarded-For entry (closest hop)', async () => {
    const { getClientIp } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(getClientIp({ headers })).toBe('5.6.7.8');
  });

  it('ignores X-Real-IP, which the client can set', async () => {
    const { getClientIp } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-real-ip': '9.9.9.9' });
    expect(getClientIp({ headers })).toBeNull();
  });

  it('ignores a request.ip property', async () => {
    const { getClientIp } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4' });
    const request = { ip: '5.6.7.8', headers } as unknown as { headers: Headers };
    expect(getClientIp(request)).toBe('1.2.3.4');
  });

  it('returns null when no IP header is set', async () => {
    const { getClientIp } = await import('../dashboard/lib/auth/trust.js');
    expect(getClientIp({ headers: new Headers() })).toBeNull();
  });

  it('skips empty XFF entries', async () => {
    const { getClientIp } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4,  , 5.6.7.8 ,  ' });
    expect(getClientIp({ headers })).toBe('5.6.7.8');
  });
});

describe('TRUSTED_PROXY_IPS against a spoofed X-Forwarded-For (GHSA-rjx9-mrqq-772w)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, TRUSTED_PROXY_IPS: '10.0.0.5' };
    delete process.env.AUTH_PROXY_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects a client-written first entry naming the trusted proxy', async () => {
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    // The client wrote "10.0.0.5", an appending proxy added the real peer.
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.5, 203.0.113.9' });
    expect(checkTrustedUpstream(headers)).toEqual({ ok: false, reason: 'untrusted-ip' });
  });

  it('accepts a request whose closest hop is the trusted proxy', async () => {
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.5' });
    expect(checkTrustedUpstream(headers)).toEqual({ ok: true });
  });
});

describe('AUTH_PROXY_SECRET', () => {
  const SECRET = 'proxy-secret-0123456789abcdef0123456789';

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, AUTH_PROXY_SECRET: SECRET };
    delete process.env.TRUSTED_PROXY_IPS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts the exact secret in X-Auth-Proxy-Secret', async () => {
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    expect(checkTrustedUpstream(new Headers({ 'X-Auth-Proxy-Secret': SECRET }))).toEqual({
      ok: true,
    });
  });

  it('rejects a missing secret', async () => {
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    expect(checkTrustedUpstream(new Headers({ 'Auth-Sub': 'admin' }))).toEqual({
      ok: false,
      reason: 'proxy-secret',
    });
  });

  it('rejects a wrong secret, a prefix and a longer value', async () => {
    const { hasValidProxySecret } = await import('../dashboard/lib/auth/trust.js');
    for (const value of ['wrong', SECRET.slice(0, -1), `${SECRET}x`, '', `${SECRET}, ${SECRET}`]) {
      expect(hasValidProxySecret(new Headers({ 'X-Auth-Proxy-Secret': value }))).toBe(false);
    }
  });

  it('is required in addition to TRUSTED_PROXY_IPS', async () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.5' });
    expect(checkTrustedUpstream(headers).ok).toBe(false);
    headers.set('X-Auth-Proxy-Secret', SECRET);
    expect(checkTrustedUpstream(headers).ok).toBe(true);
  });

  it('is not checked when unset or blank', async () => {
    process.env.AUTH_PROXY_SECRET = '   ';
    const { checkTrustedUpstream } = await import('../dashboard/lib/auth/trust.js');
    expect(checkTrustedUpstream(new Headers()).ok).toBe(true);
  });

  it('is not exposed as an identity claim', async () => {
    const { parseAuthHeaders } = await import('../dashboard/lib/auth/headers.js');
    const user = parseAuthHeaders(
      new Headers({ 'Auth-Sub': 'user-1', 'X-Auth-Proxy-Secret': SECRET })
    );
    expect(user).toEqual({ sub: 'user-1' });
  });
});

describe('constantTimeEqual', () => {
  it('compares strings', async () => {
    const { constantTimeEqual } = await import('../dashboard/lib/auth/trust.js');
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abd', 'abc')).toBe(false);
    expect(constantTimeEqual('ab', 'abc')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', 'abc')).toBe(false);
    expect(constantTimeEqual('é', 'é')).toBe(true);
    expect(constantTimeEqual('\u0000', '')).toBe(false);
  });
});

describe('getLogoutUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AUTH_MODE;
    delete process.env.AUTH_LOGOUT_URL;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns /api/auth/logout in OIDC mode', async () => {
    process.env.AUTH_MODE = 'oidc';
    const { getLogoutUrl } = await import('../dashboard/lib/auth/logout.js');
    expect(getLogoutUrl()).toBe('/api/auth/logout');
  });

  it('returns null in headers mode without AUTH_LOGOUT_URL', async () => {
    process.env.AUTH_MODE = 'headers';
    const { getLogoutUrl } = await import('../dashboard/lib/auth/logout.js');
    expect(getLogoutUrl()).toBeNull();
  });

  it('returns /api/auth/logout in headers mode with AUTH_LOGOUT_URL', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_LOGOUT_URL = 'https://portal.example.com/logout';
    const { getLogoutUrl } = await import('../dashboard/lib/auth/logout.js');
    expect(getLogoutUrl()).toBe('/api/auth/logout');
  });

  it('returns null in none mode', async () => {
    process.env.AUTH_MODE = 'none';
    const { getLogoutUrl } = await import('../dashboard/lib/auth/logout.js');
    expect(getLogoutUrl()).toBeNull();
  });
});
