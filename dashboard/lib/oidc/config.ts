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

/** Scopes requested at sign-in when OIDC_SCOPES is unset. */
export const DEFAULT_OIDC_SCOPES = 'openid email profile';

/**
 * Scopes requested at sign-in: `OIDC_SCOPES` (space- or comma-separated),
 * default "openid email profile". `openid` is always included. Some
 * providers only release the groups claim for an extra scope (Dex:
 * "groups").
 */
export function getOidcScopes(env: Record<string, string | undefined> = process.env): string {
  const raw = env.OIDC_SCOPES?.trim();
  const scopes = (raw && raw.length > 0 ? raw : DEFAULT_OIDC_SCOPES)
    .split(/[\s,]+/)
    .filter((scope) => scope.length > 0);
  if (!scopes.includes('openid')) scopes.unshift('openid');
  return [...new Set(scopes)].join(' ');
}

/** Minimum length of SESSION_SECRET (iron-session requirement). */
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Thrown by getSessionSecret() when SESSION_SECRET is missing or too short in
 * production. Callers turn it into a 500 response or a configuration error
 * page: OIDC sign-in must fail closed rather than fall back to a known key.
 */
export class SessionSecretError extends Error {
  constructor() {
    super(
      `SESSION_SECRET must be set to a random value of at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        '(generate one with: openssl rand -hex 32).'
    );
    this.name = 'SessionSecretError';
  }
}

let devSessionSecret: string | null = null;
let sessionSecretErrorLogged = false;

function generateRandomSecret(): string {
  // WebCrypto: available in Node.js >= 19 and in the Edge Runtime.
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return the secret used to seal the OIDC session cookie.
 *
 * SECURITY: there is no built-in fallback secret. When SESSION_SECRET is
 * missing or shorter than 32 characters:
 *   - in production (NODE_ENV=production), log an error once and throw a
 *     SessionSecretError, so OIDC sign-in fails closed;
 *   - otherwise (development, tests), use a random secret generated once per
 *     process, with a warning. It is also written to process.env so that the
 *     Edge middleware sandbox, created after the server starts, sees it.
 */
export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= MIN_SESSION_SECRET_LENGTH) {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new SessionSecretError();
    if (!sessionSecretErrorLogged) {
      sessionSecretErrorLogged = true;
      console.error(`[auth] ${error.message} OIDC sign-in is disabled until it is set.`);
    }
    throw error;
  }

  if (!devSessionSecret) {
    devSessionSecret = generateRandomSecret();
    console.warn(
      `[auth] SESSION_SECRET is missing or shorter than ${MIN_SESSION_SECRET_LENGTH} characters: ` +
        'using a random secret for this process (allowed because NODE_ENV is not "production"). ' +
        'Sessions will not survive a restart.'
    );
  }
  process.env.SESSION_SECRET = devSessionSecret;
  return devSessionSecret;
}

/** Whether getSessionSecret() can return a secret (never throws). */
export function isSessionSecretUsable(): boolean {
  try {
    getSessionSecret();
    return true;
  } catch {
    return false;
  }
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
