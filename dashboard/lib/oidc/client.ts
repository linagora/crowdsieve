import * as client from 'openid-client';
import { getOidcConfig } from './config';
import { getEncryptionKeys, isJweEnabled, isJwsEnabled, getCurrentSigningKey } from './keys';

let cachedConfig: client.Configuration | null = null;
let configPromise: Promise<client.Configuration | null> | null = null;

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

  // Build the discovery promise
  configPromise = (async () => {
    try {
      let config: client.Configuration;

      // When JWS is enabled, use private_key_jwt authentication
      if (isJwsEnabled()) {
        console.log('OIDC: Using private_key_jwt authentication (JWS enabled)');
        if (oidcConfig.clientSecret) {
          console.warn(
            'OIDC WARNING: Both JWS_ENABLED and OIDC_CLIENT_SECRET are configured. ' +
              'When JWS is enabled, private_key_jwt is used and client_secret is IGNORED. ' +
              'Remove OIDC_CLIENT_SECRET to suppress this warning.'
          );
        }

        const signingKey = await getCurrentSigningKey();
        if (!signingKey) {
          throw new Error('JWS enabled but no signing key available');
        }

        // Use PrivateKeyJwt as the 4th argument for client authentication
        config = await client.discovery(
          new URL(oidcConfig.issuer),
          oidcConfig.clientId,
          undefined, // No client secret metadata
          client.PrivateKeyJwt(signingKey.privateKey as client.CryptoKey)
        );
      } else {
        // Use client_secret authentication
        config = await client.discovery(
          new URL(oidcConfig.issuer),
          oidcConfig.clientId,
          oidcConfig.clientSecret
        );
      }

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
    } catch (error) {
      // Provide more specific error messages for common failure cases
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error(
          `OIDC discovery failed: Network error connecting to ${oidcConfig.issuer}`,
          error
        );
      } else if (error instanceof Error && error.message.includes('invalid_url')) {
        console.error(`OIDC discovery failed: Invalid issuer URL "${oidcConfig.issuer}"`, error);
      } else {
        console.error(`OIDC discovery failed for issuer ${oidcConfig.issuer}:`, error);
      }
      // Clear promise on error to allow retry
      configPromise = null;
      throw error;
    }
  })();

  return configPromise;
}

export function clearOidcClientCache(): void {
  cachedConfig = null;
  configPromise = null;
}
