import { NextResponse } from 'next/server';
import * as client from 'openid-client';
import { getOidcClient } from '@/lib/oidc/client';
import { getBaseUrl } from '@/lib/oidc/config';
import { getSession, clearSession } from '@/lib/oidc/session';
import { getAuthMode } from '@/lib/auth/mode';
import { getExternalLogoutUrl } from '@/lib/auth/logout';

export async function GET(): Promise<NextResponse> {
  const mode = getAuthMode();

  if (mode === 'none') {
    // No auth, nothing to do — just bounce home.
    return NextResponse.redirect(new URL('/', getBaseUrl()));
  }

  if (mode === 'headers') {
    // Headers mode is stateless — we don't own the session, the upstream
    // proxy does. Send the user to the configured external logout URL if
    // any, otherwise back to the dashboard home.
    const external = getExternalLogoutUrl();
    if (external) {
      return NextResponse.redirect(external);
    }
    return NextResponse.redirect(new URL('/', getBaseUrl()));
  }

  // OIDC mode — existing logic.
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
