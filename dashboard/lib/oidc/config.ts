export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

export type ActorClaim = 'sub' | 'email' | 'name';

const VALID_ACTOR_CLAIMS: readonly ActorClaim[] = ['sub', 'email', 'name'] as const;

export function getOidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;

  // OIDC is disabled if no issuer or clientId configured
  if (!issuer || !clientId) {
    return null;
  }

  return { issuer, clientId, clientSecret };
}

export function isOidcEnabled(): boolean {
  return getOidcConfig() !== null;
}

/**
 * Resolve the OIDC claim used to identify the human actor for audit logging.
 * Defaults to "sub" (the only claim guaranteed to be present and stable).
 * Override via OIDC_ACTOR_CLAIM=email|name|sub. Unknown values fall back to "sub".
 */
export function getActorClaim(): ActorClaim {
  const raw = process.env.OIDC_ACTOR_CLAIM?.trim().toLowerCase();
  if (raw && (VALID_ACTOR_CLAIMS as readonly string[]).includes(raw)) {
    return raw as ActorClaim;
  }
  return 'sub';
}

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }
  // Default secret for development only (exactly 32 characters)
  // WARNING: In production, SESSION_SECRET must be set explicitly
  return 'crowdsieve-dev-secret-32-chars!!';
}

export function getBaseUrl(): string {
  // In production, use the configured base URL
  if (process.env.NEXTAUTH_URL) {
    return process.env.NEXTAUTH_URL;
  }
  // For Vercel deployments
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  // Default to localhost for development
  return 'http://localhost:3000';
}
