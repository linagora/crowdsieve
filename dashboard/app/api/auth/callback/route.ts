import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { getOidcClient } from '@/lib/oidc/client';
import { isOidcEnabled, getBaseUrl } from '@/lib/oidc/config';
import { getSession, SessionUser } from '@/lib/oidc/session';
import { resolvePostLoginPath } from '@/lib/oidc/loginRedirect';

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
    const { state, nonce, codeVerifier, redirect: requestedRedirect } = session;

    if (!state || !nonce || !codeVerifier) {
      return NextResponse.redirect(new URL('/login?error=invalid_state', getBaseUrl()));
    }

    const baseUrl = getBaseUrl();

    // Reconstruct the callback URL with the correct external host
    // request.url may have internal hostname when behind reverse proxy
    const internalUrl = new URL(request.url);
    const externalUrl = new URL(`${baseUrl}${internalUrl.pathname}${internalUrl.search}`);

    // Exchange authorization code for tokens
    // Note: private_key_jwt authentication is configured at discovery time in getOidcClient()
    const tokens = await client.authorizationCodeGrant(oidcClient, externalUrl, {
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
    session.redirect = undefined;
    await session.save();

    // Send the user back to the page they originally requested (path + query
    // string), after validating it again: the value was stored in the session
    // from a user-controlled link.
    return NextResponse.redirect(new URL(resolvePostLoginPath(requestedRedirect), baseUrl));
  } catch (error) {
    console.error('Callback error:', error);
    const baseUrl = getBaseUrl();
    return NextResponse.redirect(new URL('/login?error=callback_failed', baseUrl));
  }
}
