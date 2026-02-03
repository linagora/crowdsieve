import * as client from 'openid-client';
import { getOidcConfig } from './config';
import { getEncryptionKeys, isJweEnabled, isJwsEnabled, getCurrentSigningKey } from './keys';

let cachedConfig: client.Configuration | null = null;
let configPromise: Promise<client.Configuration | null> | null = null;

async function performDiscovery(
  issuer: string,
  clientId: string,
  clientSecret?: string
): Promise<client.Configuration> {
  try {
    return await client.discovery(new URL(issuer), clientId, clientSecret);
  } catch (error) {
    // Provide more specific error messages for common failure cases
    if (error instanceof TypeError && error.message.includes('fetch')) {
      console.error(`OIDC discovery failed: Network error connecting to ${issuer}`, error);
    } else if (error instanceof Error && error.message.includes('invalid_url')) {
      console.error(`OIDC discovery failed: Invalid issuer URL "${issuer}"`, error);
    } else {
      console.error(`OIDC discovery failed for issuer ${issuer}:`, error);
    }
    throw error;
  }
}

export async function getOidcClient(): Promise<client.Configuration | null> {
  // Return cached config if available
  if (cachedConfig) {
    return cachedConfig;
  }

  // Prevent concurrent discovery calls - check and assign atomically
  if (configPromise) {
    return configPromise;
  }

  const oidcConfig = getOidcConfig();
  if (!oidcConfig) {
    return null;
  }

  // When JWS is enabled, we use private_key_jwt instead of client_secret
  // Don't pass clientSecret to discovery in that case
  const usePrivateKey = isJwsEnabled();
  const clientSecret = usePrivateKey ? undefined : oidcConfig.clientSecret;
  if (usePrivateKey) {
    console.log('OIDC: Using private_key_jwt authentication (JWS enabled)');
    if (oidcConfig.clientSecret) {
      console.warn(
        'OIDC WARNING: Both JWS_ENABLED and OIDC_CLIENT_SECRET are configured. ' +
          'When JWS is enabled, private_key_jwt is used and client_secret is IGNORED. ' +
          'Remove OIDC_CLIENT_SECRET to suppress this warning.'
      );
    }
  }

  // Assign promise immediately to prevent race conditions
  // Any concurrent calls will await this same promise
  configPromise = performDiscovery(oidcConfig.issuer, oidcConfig.clientId, clientSecret)
    .then(async (config) => {
      // Enable JWE decryption if configured
      if (isJweEnabled()) {
        const keys = await getEncryptionKeys();
        if (keys) {
          const contentEncAlgs = (process.env.JWE_CONTENT_ALGS || 'A256GCM,A128GCM').split(',');
          client.enableDecryptingResponses(
            config,
            contentEncAlgs,
            keys.current.privateKey as client.CryptoKey
          );
          console.log('JWE decryption enabled for OIDC responses');
        }
      }

      cachedConfig = config;
      return config;
    })
    .catch((error) => {
      // Clear promise on error to allow retry
      configPromise = null;
      throw error;
    });

  return configPromise;
}

export function clearOidcClientCache(): void {
  cachedConfig = null;
  configPromise = null;
}

/**
 * Check if private_key_jwt authentication should be used.
 * When JWS is enabled, we use private_key_jwt instead of client_secret.
 */
export function usePrivateKeyJwt(): boolean {
  return isJwsEnabled();
}

/**
 * Get the private key for client authentication (private_key_jwt).
 * Returns null if JWS is not enabled.
 */
export async function getClientPrivateKey(): Promise<client.CryptoKey | null> {
  if (!isJwsEnabled()) {
    return null;
  }
  const signingKey = await getCurrentSigningKey();
  return signingKey?.privateKey as client.CryptoKey | null;
}
