import { NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { getOidcClient } from '@/lib/oidc/client';
import { isOidcEnabled, getBaseUrl } from '@/lib/oidc/config';
import { getSession } from '@/lib/oidc/session';

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

    const baseUrl = getBaseUrl();
    const redirectUri = `${baseUrl}/api/auth/callback`;

    // Generate PKCE code verifier and state
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    // Store state/nonce/codeVerifier in session for verification during callback
    const session = await getSession();
    session.state = state;
    session.nonce = nonce;
    session.codeVerifier = codeVerifier;
    await session.save();

    // Build authorization URL
    const authUrl = client.buildAuthorizationUrl(oidcClient, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return NextResponse.redirect(authUrl.href);
  } catch (error) {
    console.error('Login error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
