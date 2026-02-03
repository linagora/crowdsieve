export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

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

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }
  // Generate a default secret for development (not recommended for production)
  // In production, SESSION_SECRET should be set explicitly
  return 'crowdsieve-dev-session-secret-32ch';
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
