import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { getOidcClient } from '@/lib/oidc/client';
import { isOidcEnabled, getBaseUrl } from '@/lib/oidc/config';
import { getSession, SessionUser } from '@/lib/oidc/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Return 404 if OIDC is not enabled
  if (!isOidcEnabled()) {
    return new NextResponse('Not Found', { status: 404 });
  }

  try {
    const oidcClient = await getOidcClient();
    if (!oidcClient) {
      return new NextResponse('OIDC not configured', { status: 500 });
    }

    const session = await getSession();
    const { state, nonce, codeVerifier } = session;

    if (!state || !nonce || !codeVerifier) {
      return NextResponse.redirect(new URL('/login?error=invalid_state', getBaseUrl()));
    }

    const baseUrl = getBaseUrl();

    // Exchange authorization code for tokens
    const tokens = await client.authorizationCodeGrant(oidcClient, new URL(request.url), {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });

    // Extract user info from ID token claims
    const claims = tokens.claims();
    if (!claims) {
      return NextResponse.redirect(new URL('/login?error=no_claims', baseUrl));
    }

    const user: SessionUser = {
      sub: claims.sub,
      email: claims.email as string | undefined,
      name: claims.name as string | undefined,
      picture: claims.picture as string | undefined,
    };

    // Calculate session expiration (use access token expiry or default to 1 hour)
    const expiresIn = tokens.expiresIn() ?? 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    // Update session with user info and tokens
    session.user = user;
    session.accessToken = tokens.access_token;
    session.idToken = tokens.id_token;
    session.refreshToken = tokens.refresh_token;
    session.expiresAt = expiresAt;
    // Store session ID for back-channel logout support
    session.sid = claims.sid as string | undefined;
    // Clear temporary auth state
    session.state = undefined;
    session.nonce = undefined;
    session.codeVerifier = undefined;
    await session.save();

    // Redirect to home page
    // SECURITY: We intentionally redirect to '/' and not to a user-supplied redirect
    // parameter to avoid open redirect vulnerabilities. The login page handles
    // redirect validation separately before initiating the auth flow.
    return NextResponse.redirect(new URL('/', baseUrl));
  } catch (error) {
    console.error('Callback error:', error);
    const baseUrl = getBaseUrl();
    return NextResponse.redirect(new URL('/login?error=callback_failed', baseUrl));
  }
}
