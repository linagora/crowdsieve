import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

// Mock environment variables for OIDC config tests
const originalEnv = process.env;

// Mock next/headers for session tests
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

describe('OIDC Config', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getOidcConfig', () => {
    it('should return null when OIDC is not configured', async () => {
      delete process.env.OIDC_ISSUER;
      delete process.env.OIDC_CLIENT_ID;

      const { getOidcConfig } = await import('../dashboard/lib/oidc/config.js');
      expect(getOidcConfig()).toBeNull();
    });

    it('should return null when only issuer is set', async () => {
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      delete process.env.OIDC_CLIENT_ID;

      const { getOidcConfig } = await import('../dashboard/lib/oidc/config.js');
      expect(getOidcConfig()).toBeNull();
    });

    it('should return null when only client_id is set', async () => {
      delete process.env.OIDC_ISSUER;
      process.env.OIDC_CLIENT_ID = 'my-client';

      const { getOidcConfig } = await import('../dashboard/lib/oidc/config.js');
      expect(getOidcConfig()).toBeNull();
    });

    it('should return config when issuer and client_id are set', async () => {
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'my-client';

      const { getOidcConfig } = await import('../dashboard/lib/oidc/config.js');
      const config = getOidcConfig();

      expect(config).toEqual({
        issuer: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: undefined,
      });
    });

    it('should include client_secret when set', async () => {
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'my-client';
      process.env.OIDC_CLIENT_SECRET = 'my-secret';

      const { getOidcConfig } = await import('../dashboard/lib/oidc/config.js');
      const config = getOidcConfig();

      expect(config).toEqual({
        issuer: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: 'my-secret',
      });
    });
  });

  describe('isOidcEnabled', () => {
    it('should return false when OIDC is not configured', async () => {
      delete process.env.OIDC_ISSUER;
      delete process.env.OIDC_CLIENT_ID;

      const { isOidcEnabled } = await import('../dashboard/lib/oidc/config.js');
      expect(isOidcEnabled()).toBe(false);
    });

    it('should return true when OIDC is configured', async () => {
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'my-client';

      const { isOidcEnabled } = await import('../dashboard/lib/oidc/config.js');
      expect(isOidcEnabled()).toBe(true);
    });
  });

  describe('getSessionSecret', () => {
    it('should return configured secret when valid', async () => {
      process.env.SESSION_SECRET = 'this-is-a-secret-with-32-chars!!';

      const { getSessionSecret } = await import('../dashboard/lib/oidc/config.js');
      expect(getSessionSecret()).toBe('this-is-a-secret-with-32-chars!!');
    });

    it('should return default secret when not configured', async () => {
      delete process.env.SESSION_SECRET;

      const { getSessionSecret } = await import('../dashboard/lib/oidc/config.js');
      expect(getSessionSecret()).toBe('crowdsieve-dev-session-secret-32ch');
    });

    it('should return default secret when configured secret is too short', async () => {
      process.env.SESSION_SECRET = 'short';

      const { getSessionSecret } = await import('../dashboard/lib/oidc/config.js');
      expect(getSessionSecret()).toBe('crowdsieve-dev-session-secret-32ch');
    });
  });

  describe('getBaseUrl', () => {
    it('should return NEXTAUTH_URL when set', async () => {
      process.env.NEXTAUTH_URL = 'https://dashboard.example.com';

      const { getBaseUrl } = await import('../dashboard/lib/oidc/config.js');
      expect(getBaseUrl()).toBe('https://dashboard.example.com');
    });

    it('should return VERCEL_URL when NEXTAUTH_URL not set', async () => {
      delete process.env.NEXTAUTH_URL;
      process.env.VERCEL_URL = 'my-app.vercel.app';

      const { getBaseUrl } = await import('../dashboard/lib/oidc/config.js');
      expect(getBaseUrl()).toBe('https://my-app.vercel.app');
    });

    it('should return localhost when no URL configured', async () => {
      delete process.env.NEXTAUTH_URL;
      delete process.env.VERCEL_URL;

      const { getBaseUrl } = await import('../dashboard/lib/oidc/config.js');
      expect(getBaseUrl()).toBe('http://localhost:3000');
    });
  });
});

describe('Session Revocation', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('should revoke a session by sid', async () => {
    const { revokeSession, isSessionRevoked } = await import(
      '../dashboard/lib/oidc/revocation.js'
    );

    expect(isSessionRevoked('session-123', 'user-456')).toBe(false);

    revokeSession('session-123', 'user-456');

    expect(isSessionRevoked('session-123', 'user-456')).toBe(true);
  });

  it('should not affect other sessions when revoking one', async () => {
    const { revokeSession, isSessionRevoked } = await import(
      '../dashboard/lib/oidc/revocation.js'
    );

    revokeSession('session-123', 'user-456');

    expect(isSessionRevoked('session-123', 'user-456')).toBe(true);
    expect(isSessionRevoked('session-other', 'user-456')).toBe(false);
  });

  it('should revoke all sessions for a user', async () => {
    const { revokeAllUserSessions, isSessionRevoked } = await import(
      '../dashboard/lib/oidc/revocation.js'
    );

    revokeAllUserSessions('user-789');

    // Any session for this user should be revoked
    expect(isSessionRevoked('any-session', 'user-789')).toBe(true);
    expect(isSessionRevoked('another-session', 'user-789')).toBe(true);

    // But not for other users
    expect(isSessionRevoked('any-session', 'other-user')).toBe(false);
  });

  it('should return false for undefined sid', async () => {
    const { isSessionRevoked } = await import('../dashboard/lib/oidc/revocation.js');

    expect(isSessionRevoked(undefined, 'user-123')).toBe(false);
  });
});

describe('Back-channel Logout Token Validation', () => {
  interface LogoutTokenPayload {
    iss: string;
    sub?: string;
    aud: string | string[];
    iat: number;
    jti: string;
    sid?: string;
    events: {
      'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
    };
    nonce?: string;
  }

  function validateLogoutToken(
    claims: Partial<LogoutTokenPayload>
  ): { valid: boolean; error?: string } {
    // Must contain the backchannel-logout event
    if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
      return { valid: false, error: 'missing event' };
    }

    // Must NOT contain a nonce claim
    if (claims.nonce !== undefined) {
      return { valid: false, error: 'contains nonce' };
    }

    // Must contain sub or sid
    if (!claims.sub && !claims.sid) {
      return { valid: false, error: 'must contain sub or sid' };
    }

    return { valid: true };
  }

  it('should accept valid logout token with sub and sid', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      sid: 'session-456',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutToken(token)).toEqual({ valid: true });
  });

  it('should accept valid logout token with only sub', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutToken(token)).toEqual({ valid: true });
  });

  it('should accept valid logout token with only sid', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      sid: 'session-456',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutToken(token)).toEqual({ valid: true });
  });

  it('should reject token without backchannel-logout event', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {} as LogoutTokenPayload['events'],
    };

    expect(validateLogoutToken(token)).toEqual({ valid: false, error: 'missing event' });
  });

  it('should reject token with nonce', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      nonce: 'should-not-be-here',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutToken(token)).toEqual({ valid: false, error: 'contains nonce' });
  });

  it('should reject token without sub or sid', () => {
    const token: Partial<LogoutTokenPayload> = {
      iss: 'https://auth.example.com',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutToken(token)).toEqual({ valid: false, error: 'must contain sub or sid' });
  });
});

describe('OIDC Client', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null when OIDC is not configured', async () => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;

    const { getOidcClient } = await import('../dashboard/lib/oidc/client.js');
    const client = await getOidcClient();

    expect(client).toBeNull();
  });

  it('should clear cache when clearOidcClientCache is called', async () => {
    const { clearOidcClientCache } = await import('../dashboard/lib/oidc/client.js');

    // This should not throw
    clearOidcClientCache();
  });
});

describe('Open Redirect Prevention', () => {
  // Test the redirect validation logic used in login page
  function isSafeRedirect(path: string | undefined): path is string {
    if (!path) return false;
    return path.startsWith('/') && !path.startsWith('//') && !path.includes(':');
  }

  it('should allow valid relative paths', () => {
    expect(isSafeRedirect('/')).toBe(true);
    expect(isSafeRedirect('/dashboard')).toBe(true);
    expect(isSafeRedirect('/alerts/123')).toBe(true);
    expect(isSafeRedirect('/stats?filter=today')).toBe(true);
  });

  it('should reject undefined or empty paths', () => {
    expect(isSafeRedirect(undefined)).toBe(false);
    expect(isSafeRedirect('')).toBe(false);
  });

  it('should reject absolute URLs with protocol', () => {
    expect(isSafeRedirect('https://evil.com')).toBe(false);
    expect(isSafeRedirect('http://evil.com')).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirect('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject protocol-relative URLs', () => {
    expect(isSafeRedirect('//evil.com')).toBe(false);
    expect(isSafeRedirect('//evil.com/path')).toBe(false);
  });

  it('should reject paths with embedded protocol', () => {
    expect(isSafeRedirect('/redirect?url=https://evil.com')).toBe(false);
  });

  it('should reject paths not starting with /', () => {
    expect(isSafeRedirect('evil.com')).toBe(false);
    expect(isSafeRedirect('../evil')).toBe(false);
  });
});
