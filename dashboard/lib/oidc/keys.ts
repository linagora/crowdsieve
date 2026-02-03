import { generateKeyPair, exportJWK, importJWK, KeyLike } from 'jose';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Keys for decrypting JWE tokens from the OIDC provider
// The public key is published via JWKS so the provider can encrypt tokens for us

export interface EncryptionKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
}

interface StoredKeyPair {
  privateKey: object;
  publicKey: object;
  kid: string;
}

let cachedKeys: EncryptionKeys | null = null;

function getKeysPath(): string | null {
  return process.env.JWE_KEYS_PATH || null;
}

function generateKid(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `crowdsieve-enc-${timestamp}-${random}`;
}

function getKeyAlgorithm(): string {
  return process.env.JWE_KEY_ALG || 'RSA-OAEP-256';
}

async function loadKeysFromFile(path: string): Promise<EncryptionKeys | null> {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const data = JSON.parse(readFileSync(path, 'utf-8')) as StoredKeyPair;
    const alg = getKeyAlgorithm();

    const privateKey = (await importJWK(data.privateKey, alg)) as KeyLike;
    const publicKey = (await importJWK(data.publicKey, alg)) as KeyLike;

    return {
      privateKey,
      publicKey,
      kid: data.kid,
    };
  } catch (error) {
    console.error('Failed to load encryption keys from file:', error);
    return null;
  }
}

async function saveKeysToFile(path: string, keys: EncryptionKeys): Promise<void> {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: StoredKeyPair = {
      privateKey: await exportJWK(keys.privateKey),
      publicKey: await exportJWK(keys.publicKey),
      kid: keys.kid,
    };

    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    console.log('Encryption keys saved to:', path);
  } catch (error) {
    console.error('Failed to save encryption keys to file:', error);
  }
}

export async function getEncryptionKeys(): Promise<EncryptionKeys | null> {
  // Return cached keys if available
  if (cachedKeys) {
    return cachedKeys;
  }

  // Check if JWE is enabled
  if (!isJweEnabled()) {
    return null;
  }

  // Try to load from file
  const keysPath = getKeysPath();
  if (keysPath) {
    const loaded = await loadKeysFromFile(keysPath);
    if (loaded) {
      cachedKeys = loaded;
      console.log('Encryption keys loaded from:', keysPath);
      return cachedKeys;
    }
  }

  // Generate new keys
  const alg = getKeyAlgorithm();
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });

  cachedKeys = {
    privateKey,
    publicKey,
    kid: generateKid(),
  };

  console.log('Generated new encryption keys');

  // Save to file if path is configured
  if (keysPath) {
    await saveKeysToFile(keysPath, cachedKeys);
  } else {
    console.warn('JWE_KEYS_PATH not set - encryption keys will be regenerated on restart');
  }

  return cachedKeys;
}

export function isJweEnabled(): boolean {
  return process.env.JWE_ENABLED === 'true';
}

export async function getPublicJWKS(): Promise<{ keys: object[] }> {
  const keys = await getEncryptionKeys();
  if (!keys) {
    return { keys: [] };
  }

  const publicJwk = await exportJWK(keys.publicKey);
  const alg = getKeyAlgorithm();

  return {
    keys: [
      {
        ...publicJwk,
        kid: keys.kid,
        use: 'enc',
        alg: alg,
      },
    ],
  };
}

export function clearKeysCache(): void {
  cachedKeys = null;
}
