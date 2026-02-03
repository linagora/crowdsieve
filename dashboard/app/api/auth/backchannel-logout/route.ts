import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isOidcEnabled, getOidcConfig } from '@/lib/oidc/config';
import { revokeSession, revokeAllUserSessions } from '@/lib/oidc/revocation';

// Back-channel logout endpoint
// This is called directly by the OIDC provider when a user logs out
// See: https://openid.net/specs/openid-connect-backchannel-1_0.html

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

// Cache the JWKS getter per issuer (createRemoteJWKSet handles key caching internally)
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Track used jtis to prevent replay attacks (with expiration)
const usedJtis = new Map<string, number>();
const JTI_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function isJtiUsed(jti: string): boolean {
  const now = Date.now();
  // Clean up expired jtis periodically
  if (usedJtis.size > 100) {
    for (const [key, expiry] of usedJtis) {
      if (expiry < now) {
        usedJtis.delete(key);
      }
    }
  }
  return usedJtis.has(jti) && usedJtis.get(jti)! > now;
}

function markJtiUsed(jti: string): void {
  usedJtis.set(jti, Date.now() + JTI_EXPIRY_MS);
}

async function getJWKS(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const cached = jwksCache.get(issuer);
  if (cached) {
    return cached;
  }

  // Fetch the OpenID configuration to get the JWKS URI
  const wellKnownUrl = new URL('/.well-known/openid-configuration', issuer);
  const configResponse = await fetch(wellKnownUrl.toString());
  if (!configResponse.ok) {
    throw new Error(`Failed to fetch OpenID configuration: ${configResponse.status}`);
  }
  const config = await configResponse.json();
  const jwksUri = config.jwks_uri;

  if (!jwksUri) {
    throw new Error('No jwks_uri in OpenID configuration');
  }

  // createRemoteJWKSet handles key caching and rotation internally
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  jwksCache.set(issuer, jwks);
  return jwks;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Return 404 if OIDC is not enabled
  if (!isOidcEnabled()) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const oidcConfig = getOidcConfig();
  if (!oidcConfig) {
    return new NextResponse('OIDC not configured', { status: 500 });
  }

  try {
    // Parse the form body
    const formData = await request.formData();
    const logoutToken = formData.get('logout_token');

    if (!logoutToken || typeof logoutToken !== 'string') {
      return new NextResponse('Missing logout_token', { status: 400 });
    }

    // Get the JWKS for signature verification
    const JWKS = await getJWKS(oidcConfig.issuer);

    // Verify the JWT signature and decode claims
    const { payload } = await jwtVerify(logoutToken, JWKS, {
      issuer: oidcConfig.issuer,
      audience: oidcConfig.clientId,
    });

    const claims = payload as unknown as LogoutTokenPayload;

    // Validate logout token specific claims per spec
    // Must contain the backchannel-logout event
    if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
      console.error('Missing backchannel-logout event in logout token');
      return new NextResponse('Invalid logout_token: missing event', { status: 400 });
    }

    // Must NOT contain a nonce claim
    if (claims.nonce !== undefined) {
      console.error('Logout token must not contain nonce');
      return new NextResponse('Invalid logout_token: contains nonce', { status: 400 });
    }

    // Validate jti to prevent replay attacks
    if (!claims.jti) {
      console.error('Logout token missing jti');
      return new NextResponse('Invalid logout_token: missing jti', { status: 400 });
    }
    if (isJtiUsed(claims.jti)) {
      console.error('Logout token jti already used (replay attack?)');
      return new NextResponse('Invalid logout_token: jti already used', { status: 400 });
    }
    markJtiUsed(claims.jti);

    // Extract sub and sid from the logout token
    const sub = claims.sub;
    const sid = claims.sid;

    if (!sub && !sid) {
      return new NextResponse('Logout token must contain sub or sid', { status: 400 });
    }

    // Revoke the session(s)
    if (sid && sub) {
      // Specific session logout
      revokeSession(sid, sub);
      console.log(`Back-channel logout: revoked session sid=${sid} for sub=${sub}`);
    } else if (sub) {
      // All sessions for user logout
      revokeAllUserSessions(sub);
      console.log(`Back-channel logout: revoked all sessions for sub=${sub}`);
    } else if (sid) {
      // Session-only logout (rare, but spec allows it)
      revokeSession(sid, 'unknown');
      console.log(`Back-channel logout: revoked session sid=${sid}`);
    }

    // Return 200 OK as per spec (must be a 200 response with cache-control headers)
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Back-channel logout error:', error);
    // Per spec, we should return 400 for client errors, 501 for unsupported
    return new NextResponse('Invalid logout_token', { status: 400 });
  }
}
