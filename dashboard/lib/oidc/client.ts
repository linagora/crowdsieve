import * as client from 'openid-client';
import { getOidcConfig } from './config';

let cachedConfig: client.Configuration | null = null;
let configPromise: Promise<client.Configuration | null> | null = null;

export async function getOidcClient(): Promise<client.Configuration | null> {
  // Return cached config if available
  if (cachedConfig) {
    return cachedConfig;
  }

  // Prevent concurrent discovery calls
  if (configPromise) {
    return configPromise;
  }

  const oidcConfig = getOidcConfig();
  if (!oidcConfig) {
    return null;
  }

  configPromise = (async () => {
    try {
      const config = await client.discovery(
        new URL(oidcConfig.issuer),
        oidcConfig.clientId,
        oidcConfig.clientSecret
      );
      cachedConfig = config;
      return config;
    } catch (error) {
      console.error('OIDC discovery failed:', error);
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
