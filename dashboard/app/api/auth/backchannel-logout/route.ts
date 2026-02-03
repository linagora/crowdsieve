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

// Cache the JWKS getter
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getJWKS(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwksCache) {
    return jwksCache;
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

  jwksCache = createRemoteJWKSet(new URL(jwksUri));
  return jwksCache;
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
