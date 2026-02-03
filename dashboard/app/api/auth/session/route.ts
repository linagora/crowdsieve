import { NextResponse } from 'next/server';
import { isOidcEnabled } from '@/lib/oidc/config';
import { getSession, isSessionValid, SessionUser } from '@/lib/oidc/session';

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
  expiresAt: number | null;
}

export async function GET(): Promise<NextResponse<SessionResponse>> {
  // If OIDC is not enabled, return unauthenticated (but not 404 for client convenience)
  if (!isOidcEnabled()) {
    return NextResponse.json({
      authenticated: false,
      user: null,
      expiresAt: null,
    });
  }

  try {
    // Use isSessionValid to check expiration AND revocation
    if (!(await isSessionValid())) {
      return NextResponse.json({
        authenticated: false,
        user: null,
        expiresAt: null,
      });
    }

    const session = await getSession();

    return NextResponse.json({
      authenticated: true,
      user: session.user ?? null,
      expiresAt: session.expiresAt ?? null,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json({
      authenticated: false,
      user: null,
      expiresAt: null,
    });
  }
}
