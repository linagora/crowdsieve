import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getAuthMode } from '@/lib/auth/mode';
import { parseAuthHeaders } from '@/lib/auth/headers';
import { getLogoutUrl } from '@/lib/auth/logout';
import { getSession, isSessionValid, SessionUser } from '@/lib/oidc/session';

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
  expiresAt: number | null;
  /**
   * Where the UI's "Sign out" link should point. `null` means the link
   * should be hidden (e.g. headers mode without an external logout URL).
   */
  logoutUrl: string | null;
}

export async function GET(): Promise<NextResponse<SessionResponse>> {
  const mode = getAuthMode();
  const logoutUrl = getLogoutUrl();

  // No authentication configured — return unauthenticated stub for client
  // convenience (matches historical behavior when OIDC isn't set up).
  if (mode === 'none') {
    return NextResponse.json({
      authenticated: false,
      user: null,
      expiresAt: null,
      logoutUrl: null,
    });
  }

  if (mode === 'headers') {
    try {
      const h = await headers();
      const user = parseAuthHeaders(h);
      return NextResponse.json({
        authenticated: user !== null,
        user,
        expiresAt: null,
        logoutUrl,
      });
    } catch (error) {
      console.error('Headers session check error:', error);
      return NextResponse.json({
        authenticated: false,
        user: null,
        expiresAt: null,
        logoutUrl,
      });
    }
  }

  // OIDC mode — existing logic.
  try {
    if (!(await isSessionValid())) {
      return NextResponse.json({
        authenticated: false,
        user: null,
        expiresAt: null,
        logoutUrl,
      });
    }

    const session = await getSession();

    return NextResponse.json({
      authenticated: true,
      user: session.user ?? null,
      expiresAt: session.expiresAt ?? null,
      logoutUrl,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json({
      authenticated: false,
      user: null,
      expiresAt: null,
      logoutUrl,
    });
  }
}
