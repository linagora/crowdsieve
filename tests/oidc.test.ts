import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
      const secret = getSessionSecret();
      expect(secret.length).toBeGreaterThanOrEqual(32);
    });

    it('should return default secret when configured secret is too short', async () => {
      process.env.SESSION_SECRET = 'short';

      const { getSessionSecret } = await import('../dashboard/lib/oidc/config.js');
      const secret = getSessionSecret();
      expect(secret.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe('getActorClaim', () => {
    it('should default to "sub" when OIDC_ACTOR_CLAIM is not set', async () => {
      delete process.env.OIDC_ACTOR_CLAIM;

      const { getActorClaim } = await import('../dashboard/lib/oidc/config.js');
      expect(getActorClaim()).toBe('sub');
    });

    it.each(['sub', 'email', 'name'])('should accept "%s" as a valid claim', async (claim) => {
      process.env.OIDC_ACTOR_CLAIM = claim;

      const { getActorClaim } = await import('../dashboard/lib/oidc/config.js');
      expect(getActorClaim()).toBe(claim);
    });

    it('should be case-insensitive and trim whitespace', async () => {
      process.env.OIDC_ACTOR_CLAIM = '  EMAIL  ';

      const { getActorClaim } = await import('../dashboard/lib/oidc/config.js');
      expect(getActorClaim()).toBe('email');
    });

    it('should fall back to "sub" for unknown claim values', async () => {
      process.env.OIDC_ACTOR_CLAIM = 'preferred_username';

      const { getActorClaim } = await import('../dashboard/lib/oidc/config.js');
      expect(getActorClaim()).toBe('sub');
    });

    it('should fall back to "sub" for empty string', async () => {
      process.env.OIDC_ACTOR_CLAIM = '';

      const { getActorClaim } = await import('../dashboard/lib/oidc/config.js');
      expect(getActorClaim()).toBe('sub');
    });
  });

  describe('resolveActor', () => {
    const user = { sub: 'user-123', email: 'alice@example.com', name: 'Alice' };

    it('should return empty string for null/undefined user', async () => {
      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor(null)).toBe('');
      expect(resolveActor(undefined)).toBe('');
    });

    it('should default to sub when OIDC_ACTOR_CLAIM is not set', async () => {
      delete process.env.OIDC_ACTOR_CLAIM;

      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor(user)).toBe('user-123');
    });

    it('should use email when OIDC_ACTOR_CLAIM=email', async () => {
      process.env.OIDC_ACTOR_CLAIM = 'email';

      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor(user)).toBe('alice@example.com');
    });

    it('should use name when OIDC_ACTOR_CLAIM=name', async () => {
      process.env.OIDC_ACTOR_CLAIM = 'name';

      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor(user)).toBe('Alice');
    });

    it('should fall back to sub when configured claim is missing on user', async () => {
      process.env.OIDC_ACTOR_CLAIM = 'email';

      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor({ sub: 'user-456' })).toBe('user-456');
    });

    it('should fall back to sub when configured claim is empty/whitespace', async () => {
      process.env.OIDC_ACTOR_CLAIM = 'email';

      const { resolveActor } = await import('../dashboard/lib/oidc/session.js');
      expect(resolveActor({ sub: 'user-789', email: '   ' })).toBe('user-789');
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
  // Import the actual implementation to ensure tests match production behavior
  let validateLogoutTokenClaims: (
    claims: Partial<import('../dashboard/lib/oidc/validation.js').LogoutTokenClaims>
  ) => import('../dashboard/lib/oidc/validation.js').LogoutTokenValidationResult;

  beforeEach(async () => {
    const validation = await import('../dashboard/lib/oidc/validation.js');
    validateLogoutTokenClaims = validation.validateLogoutTokenClaims;
  });

  it('should accept valid logout token with sub and sid', () => {
    const token = {
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

    expect(validateLogoutTokenClaims(token)).toEqual({ valid: true });
  });

  it('should accept valid logout token with only sub', () => {
    const token = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutTokenClaims(token)).toEqual({ valid: true });
  });

  it('should accept valid logout token with only sid', () => {
    const token = {
      iss: 'https://auth.example.com',
      sid: 'session-456',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutTokenClaims(token)).toEqual({ valid: true });
  });

  it('should reject token without backchannel-logout event', () => {
    const token = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {} as { 'http://schemas.openid.net/event/backchannel-logout': Record<string, never> },
    };

    expect(validateLogoutTokenClaims(token)).toEqual({
      valid: false,
      error: 'missing backchannel-logout event',
    });
  });

  it('should reject token with nonce', () => {
    const token = {
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

    expect(validateLogoutTokenClaims(token)).toEqual({
      valid: false,
      error: 'logout token must not contain nonce',
    });
  });

  it('should reject token without sub or sid', () => {
    const token = {
      iss: 'https://auth.example.com',
      aud: 'my-client',
      iat: Date.now() / 1000,
      jti: 'unique-id',
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
      },
    };

    expect(validateLogoutTokenClaims(token)).toEqual({
      valid: false,
      error: 'logout token must contain sub or sid',
    });
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

describe('JWE Key Management', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return false when JWE is not enabled', async () => {
    delete process.env.JWE_ENABLED;

    const { isJweEnabled } = await import('../dashboard/lib/oidc/keys.js');
    expect(isJweEnabled()).toBe(false);
  });

  it('should return true when JWE is enabled', async () => {
    process.env.JWE_ENABLED = 'true';

    const { isJweEnabled } = await import('../dashboard/lib/oidc/keys.js');
    expect(isJweEnabled()).toBe(true);
  });

  it('should return null keys when JWE is not enabled', async () => {
    delete process.env.JWE_ENABLED;

    const { getEncryptionKeys } = await import('../dashboard/lib/oidc/keys.js');
    const keys = await getEncryptionKeys();
    expect(keys).toBeNull();
  });

  it('should generate encryption keys when JWE is enabled', async () => {
    process.env.JWE_ENABLED = 'true';

    const { getEncryptionKeys, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const keys = await getEncryptionKeys();
    expect(keys).not.toBeNull();
    expect(keys?.current.privateKey).toBeDefined();
    expect(keys?.current.publicKey).toBeDefined();
    expect(keys?.current.kid).toMatch(/^crowdsieve-enc-/);
  });

  it('should return empty JWKS when JWE and JWS are not enabled', async () => {
    delete process.env.JWE_ENABLED;
    delete process.env.JWS_ENABLED;

    const { getPublicJWKS } = await import('../dashboard/lib/oidc/keys.js');
    const jwks = await getPublicJWKS();
    expect(jwks).toEqual({ keys: [] });
  });

  it('should return JWKS with encryption key when JWE is enabled', async () => {
    process.env.JWE_ENABLED = 'true';
    delete process.env.JWS_ENABLED;

    const { getPublicJWKS, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const jwks = await getPublicJWKS();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toHaveProperty('use', 'enc');
    expect(jwks.keys[0]).toHaveProperty('alg', 'RSA-OAEP-256');
    expect(jwks.keys[0]).toHaveProperty('kid');
    expect(jwks.keys[0]).toHaveProperty('kty', 'RSA');
  });

  it('should cache encryption keys between calls', async () => {
    process.env.JWE_ENABLED = 'true';

    const { getEncryptionKeys, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const keys1 = await getEncryptionKeys();
    const keys2 = await getEncryptionKeys();

    expect(keys1?.current.kid).toBe(keys2?.current.kid);
  });
});

describe('JWS Key Management with Rotation', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return false when JWS is not enabled', async () => {
    delete process.env.JWS_ENABLED;

    const { isJwsEnabled } = await import('../dashboard/lib/oidc/keys.js');
    expect(isJwsEnabled()).toBe(false);
  });

  it('should return true when JWS is enabled', async () => {
    process.env.JWS_ENABLED = 'true';

    const { isJwsEnabled } = await import('../dashboard/lib/oidc/keys.js');
    expect(isJwsEnabled()).toBe(true);
  });

  it('should generate signing keys with next, current, and null previous', async () => {
    process.env.JWS_ENABLED = 'true';

    const { getSigningKeys, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const keys = await getSigningKeys();
    expect(keys).not.toBeNull();
    expect(keys?.next.kid).toMatch(/^crowdsieve-sig-/);
    expect(keys?.current.kid).toMatch(/^crowdsieve-sig-/);
    expect(keys?.previous).toBeNull();
    // next and current should be different keys
    expect(keys?.next.kid).not.toBe(keys?.current.kid);
  });

  it('should return JWKS with signing keys when JWS is enabled', async () => {
    process.env.JWS_ENABLED = 'true';
    delete process.env.JWE_ENABLED;

    const { getPublicJWKS, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const jwks = await getPublicJWKS();
    // Should have 2 keys (current and next, no previous yet)
    expect(jwks.keys.length).toBe(2);
    expect(jwks.keys[0]).toHaveProperty('use', 'sig');
    expect(jwks.keys[0]).toHaveProperty('alg', 'RS256');
  });

  it('should return JWKS with both signing and encryption keys', async () => {
    process.env.JWS_ENABLED = 'true';
    process.env.JWE_ENABLED = 'true';

    const { getPublicJWKS, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const jwks = await getPublicJWKS();
    // Should have 3 keys: 2 signing (current, next) + 1 encryption
    expect(jwks.keys.length).toBe(3);

    const sigKeys = jwks.keys.filter((k: { use?: string }) => k.use === 'sig');
    const encKeys = jwks.keys.filter((k: { use?: string }) => k.use === 'enc');

    expect(sigKeys.length).toBe(2);
    expect(encKeys.length).toBe(1);
  });

  it('should rotate keys and keep previous', async () => {
    process.env.JWS_ENABLED = 'true';
    process.env.JWE_ENABLED = 'true';

    const { getSigningKeys, getEncryptionKeys, forceRotation, clearKeysCache } = await import(
      '../dashboard/lib/oidc/keys.js'
    );
    clearKeysCache();

    // Get initial keys
    const initialSig = await getSigningKeys();
    const initialEnc = await getEncryptionKeys();

    const initialCurrentSigKid = initialSig?.current.kid;
    const initialNextSigKid = initialSig?.next.kid;
    const initialEncKid = initialEnc?.current.kid;

    // Force rotation
    await forceRotation();

    // Get rotated keys
    const rotatedSig = await getSigningKeys();
    const rotatedEnc = await getEncryptionKeys();

    // After rotation: next -> current -> previous
    expect(rotatedSig?.current.kid).toBe(initialNextSigKid);
    expect(rotatedSig?.previous?.kid).toBe(initialCurrentSigKid);
    expect(rotatedSig?.next.kid).not.toBe(initialNextSigKid); // new next key

    // Encryption: current -> previous
    expect(rotatedEnc?.previous?.kid).toBe(initialEncKid);
    expect(rotatedEnc?.current.kid).not.toBe(initialEncKid); // new current key
  });

  it('should provide decryption keys including previous', async () => {
    process.env.JWE_ENABLED = 'true';

    const { getDecryptionKeys, forceRotation, clearKeysCache } = await import(
      '../dashboard/lib/oidc/keys.js'
    );
    clearKeysCache();

    // Initially only current key
    let decryptionKeys = await getDecryptionKeys();
    expect(decryptionKeys.length).toBe(1);

    // After rotation, should have current and previous
    await forceRotation();
    decryptionKeys = await getDecryptionKeys();
    expect(decryptionKeys.length).toBe(2);
  });

  it('should not auto-rotate when JWE_KEY_ROTATION_DAYS is not set', async () => {
    process.env.JWS_ENABLED = 'true';
    delete process.env.JWE_KEY_ROTATION_DAYS;

    const { getSigningKeys, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const keys1 = await getSigningKeys();
    const kid1 = keys1?.current.kid;

    // Call again - should not rotate since no rotation days configured
    const keys2 = await getSigningKeys();
    expect(keys2?.current.kid).toBe(kid1);
  });

  it('should not auto-rotate when JWE_KEY_ROTATION_DAYS is invalid', async () => {
    process.env.JWS_ENABLED = 'true';
    process.env.JWE_KEY_ROTATION_DAYS = 'invalid';

    const { getSigningKeys, clearKeysCache } = await import('../dashboard/lib/oidc/keys.js');
    clearKeysCache();

    const keys1 = await getSigningKeys();
    const kid1 = keys1?.current.kid;

    // Call again - should not rotate since rotation days is invalid
    const keys2 = await getSigningKeys();
    expect(keys2?.current.kid).toBe(kid1);
  });
});

describe('Open Redirect Prevention', () => {
  // Import the actual implementation to ensure tests match production behavior
  let isSafeRedirect: (path: string | undefined) => path is string;

  beforeEach(async () => {
    const validation = await import('../dashboard/lib/oidc/validation.js');
    isSafeRedirect = validation.isSafeRedirect;
  });

  it('should allow valid relative paths', () => {
    expect(isSafeRedirect('/')).toBe(true);
    expect(isSafeRedirect('/dashboard')).toBe(true);
    expect(isSafeRedirect('/alerts/123')).toBe(true);
    expect(isSafeRedirect('/stats?filter=today')).toBe(true);
  });

  it('should allow paths with colons in query parameters', () => {
    expect(isSafeRedirect('/time?hour=12:30:00')).toBe(true);
    expect(isSafeRedirect('/search?q=foo:bar')).toBe(true);
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

  it('should reject paths not starting with /', () => {
    expect(isSafeRedirect('evil.com')).toBe(false);
    expect(isSafeRedirect('../evil')).toBe(false);
  });
});
