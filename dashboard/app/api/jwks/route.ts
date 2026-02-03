import { NextResponse } from 'next/server';
import { getPublicJWKS, isJweEnabled, isJwsEnabled } from '@/lib/oidc/keys';

// JWKS endpoint for publishing CrowdSieve's public keys
// Depending on configuration, the OIDC provider uses these keys for:
// - Signing (JWS): verifying client authentication (private_key_jwt)
// - Encryption (JWE): encrypting ID tokens and logout tokens for CrowdSieve

export async function GET(): Promise<NextResponse> {
  // Return empty JWKS if neither JWS nor JWE is enabled
  if (!isJwsEnabled() && !isJweEnabled()) {
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
