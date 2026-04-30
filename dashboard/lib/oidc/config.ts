export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

/**
 * The actor claim is now an arbitrary (non-empty) claim name. We keep this
 * type alias for back-compat; consumers should treat it as a plain string.
 */
export type ActorClaim = string;

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
 * Resolve the claim used to identify the human actor for audit logging.
 * Defaults to `sub` (always present and stable).
 *
 * Override priority:
 *   1. `AUTH_ACTOR_CLAIM` (canonical name in the new auth-mode world)
 *   2. `OIDC_ACTOR_CLAIM` (kept for back-compat)
 *
 * Any non-empty string is accepted verbatim (after trimming). This allows
 * callers to use claims forwarded by the headers-auth mode such as
 * `preferredUsername`, `familyName`, etc.
 *
 * Empty / whitespace-only values fall back to `sub`.
 */
export function getActorClaim(): ActorClaim {
  const fromAuth = process.env.AUTH_ACTOR_CLAIM?.trim();
  if (fromAuth && fromAuth.length > 0) return fromAuth;
  const fromOidc = process.env.OIDC_ACTOR_CLAIM?.trim();
  if (fromOidc && fromOidc.length > 0) return fromOidc;
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
