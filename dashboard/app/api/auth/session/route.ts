import { NextRequest, NextResponse } from 'next/server';
import { isOidcEnabled } from '@/lib/oidc/config';
import { getSession, SessionUser } from '@/lib/oidc/session';

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
  expiresAt: number | null;
}

export async function GET(request: NextRequest): Promise<NextResponse<SessionResponse>> {
  // If OIDC is not enabled, return unauthenticated (but not 404 for client convenience)
  if (!isOidcEnabled()) {
    return NextResponse.json({
      authenticated: false,
      user: null,
      expiresAt: null,
    });
  }

  try {
    const session = await getSession();

    if (!session.user) {
      return NextResponse.json({
        authenticated: false,
        user: null,
        expiresAt: null,
      });
    }

    // Check if session has expired
    if (session.expiresAt && Date.now() > session.expiresAt) {
      return NextResponse.json({
        authenticated: false,
        user: null,
        expiresAt: null,
      });
    }

    return NextResponse.json({
      authenticated: true,
      user: session.user,
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
