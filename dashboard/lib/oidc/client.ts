import * as client from 'openid-client';
import { getOidcConfig } from './config';
import { getEncryptionKeys, isJweEnabled } from './keys';

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

  // Assign promise immediately to prevent race conditions
  // Any concurrent calls will await this same promise
  configPromise = performDiscovery(oidcConfig.issuer, oidcConfig.clientId, oidcConfig.clientSecret)
    .then(async (config) => {
      // Enable JWE decryption if configured
      if (isJweEnabled()) {
        const keys = await getEncryptionKeys();
        if (keys) {
          const contentEncAlgs = (process.env.JWE_CONTENT_ALGS || 'A256GCM,A128GCM').split(',');
          client.enableDecryptingResponses(
            config,
            contentEncAlgs,
            keys.privateKey as client.CryptoKey
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
