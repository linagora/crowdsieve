import { NextResponse } from 'next/server';
import { getPublicJWKS, isJweEnabled } from '@/lib/oidc/keys';

// JWKS endpoint for publishing CrowdSieve's public encryption key
// The OIDC provider uses this to encrypt ID tokens (JWE) for CrowdSieve

export async function GET(): Promise<NextResponse> {
  // Return empty JWKS if JWE is not enabled
  if (!isJweEnabled()) {
    return NextResponse.json(
      { keys: [] },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600',
        },
      }
    );
  }

  const jwks = await getPublicJWKS();

  return NextResponse.json(jwks, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': 'application/json',
    },
  });
}
