import { NextResponse } from 'next/server';
import * as client from 'openid-client';
import { getOidcClient } from '@/lib/oidc/client';
import { isOidcEnabled, getBaseUrl } from '@/lib/oidc/config';
import { getSession, clearSession } from '@/lib/oidc/session';

export async function GET(): Promise<NextResponse> {
  // Return 404 if OIDC is not enabled
  if (!isOidcEnabled()) {
    return new NextResponse('Not Found', { status: 404 });
  }

  try {
    const baseUrl = getBaseUrl();
    const session = await getSession();
    const idToken = session.idToken;

    // Clear the session
    await clearSession();

    // Try to get the OIDC client for end session URL
    const oidcClient = await getOidcClient();
    if (oidcClient && idToken) {
      // Build end session URL if the provider supports it
      try {
        const endSessionUrl = client.buildEndSessionUrl(oidcClient, {
          id_token_hint: idToken,
          post_logout_redirect_uri: baseUrl,
        });
        return NextResponse.redirect(endSessionUrl.href);
      } catch {
        // Provider might not support end_session_endpoint, just redirect to home
      }
    }

    // Redirect to login page
    return NextResponse.redirect(new URL('/login', baseUrl));
  } catch (error) {
    console.error('Logout error:', error);
    // Even if there's an error, try to clear session and redirect
    try {
      await clearSession();
    } catch {
      // Ignore errors during cleanup
    }
    return NextResponse.redirect(new URL('/login', getBaseUrl()));
  }
}
