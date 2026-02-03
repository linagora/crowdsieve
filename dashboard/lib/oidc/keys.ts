import { generateKeyPair, exportJWK, importJWK, KeyLike } from 'jose';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

/**
 * JWKS Key Management with Rotation Support
 *
 * Signing keys: 3 keys published (next, current, previous) for seamless rotation
 * Encryption keys: 1 key published (current) + previous kept for decryption
 *
 * Key rotation happens automatically based on JWE_KEY_ROTATION_DAYS (no default, disabled if not configured)
 */

// Key types
export interface KeyWithMetadata {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
  createdAt: number;
}

export interface SigningKeySet {
  next: KeyWithMetadata;
  current: KeyWithMetadata;
  previous: KeyWithMetadata | null;
}

export interface EncryptionKeySet {
  current: KeyWithMetadata;
  previous: KeyWithMetadata | null; // Kept for decrypting old tokens
}

interface StoredKey {
  privateKey: object;
  publicKey: object;
  kid: string;
  createdAt: number;
}

interface StoredKeySet {
  signing: {
    next: StoredKey;
    current: StoredKey;
    previous: StoredKey | null;
  };
  encryption: {
    current: StoredKey;
    previous: StoredKey | null;
  };
  lastRotation: number;
}

// Cached key sets
let signingKeys: SigningKeySet | null = null;
let encryptionKeys: EncryptionKeySet | null = null;
let lastRotationCheck: number = 0;
let initPromise: Promise<void> | null = null; // Lock to prevent concurrent initialization

// Configuration
function getKeysPath(): string | null {
  return process.env.JWE_KEYS_PATH || null;
}

function getSigningAlgorithm(): string {
  return process.env.JWS_KEY_ALG || 'RS256';
}

function getEncryptionAlgorithm(): string {
  return process.env.JWE_KEY_ALG || 'RSA-OAEP-256';
}

function getRotationDays(): number | null {
  const envValue = process.env.JWE_KEY_ROTATION_DAYS;
  if (!envValue) {
    return null; // No rotation if not configured
  }
  const days = parseInt(envValue, 10);
  return isNaN(days) || days < 1 ? null : days;
}

function generateKid(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(6).toString('hex');
  return `crowdsieve-${prefix}-${timestamp}-${random}`;
}

export function isJweEnabled(): boolean {
  return process.env.JWE_ENABLED === 'true';
}

export function isJwsEnabled(): boolean {
  return process.env.JWS_ENABLED === 'true';
}

// Key generation
async function generateSigningKey(): Promise<KeyWithMetadata> {
  const alg = getSigningAlgorithm();
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  return {
    privateKey,
    publicKey,
    kid: generateKid('sig'),
    createdAt: Date.now(),
  };
}

async function generateEncryptionKey(): Promise<KeyWithMetadata> {
  const alg = getEncryptionAlgorithm();
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  return {
    privateKey,
    publicKey,
    kid: generateKid('enc'),
    createdAt: Date.now(),
  };
}

// Serialization helpers
async function serializeKey(key: KeyWithMetadata): Promise<StoredKey> {
  return {
    privateKey: await exportJWK(key.privateKey),
    publicKey: await exportJWK(key.publicKey),
    kid: key.kid,
    createdAt: key.createdAt,
  };
}

async function deserializeKey(stored: StoredKey, alg: string): Promise<KeyWithMetadata> {
  return {
    privateKey: (await importJWK(stored.privateKey, alg)) as KeyLike,
    publicKey: (await importJWK(stored.publicKey, alg)) as KeyLike,
    kid: stored.kid,
    createdAt: stored.createdAt,
  };
}

// File I/O
async function loadKeysFromFile(path: string): Promise<StoredKeySet | null> {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredKeySet;
  } catch (error) {
    console.error('Failed to load keys from file:', error);
    return null;
  }
}

async function saveKeysToFile(path: string): Promise<void> {
  // Save if we have at least one key set
  if (!signingKeys && !encryptionKeys) return;

  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: Partial<StoredKeySet> & { lastRotation: number } = {
      lastRotation: Date.now(),
    };

    // Save signing keys if available
    if (signingKeys) {
      data.signing = {
        next: await serializeKey(signingKeys.next),
        current: await serializeKey(signingKeys.current),
        previous: signingKeys.previous ? await serializeKey(signingKeys.previous) : null,
      };
    }

    // Save encryption keys if available
    if (encryptionKeys) {
      data.encryption = {
        current: await serializeKey(encryptionKeys.current),
        previous: encryptionKeys.previous ? await serializeKey(encryptionKeys.previous) : null,
      };
    }

    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    console.log('Keys saved to:', path);
  } catch (error) {
    console.error('Failed to save keys to file:', error);
  }
}

// Key rotation
function shouldRotate(lastRotation: number): boolean {
  const rotationDays = getRotationDays();
  if (rotationDays === null) {
    return false; // No rotation if not configured
  }
  const rotationMs = rotationDays * 24 * 60 * 60 * 1000;
  return Date.now() - lastRotation > rotationMs;
}

async function rotateKeys(): Promise<void> {
  console.log('Rotating keys...');

  if (signingKeys) {
    // Rotate signing keys: next -> current -> previous
    signingKeys = {
      previous: signingKeys.current,
      current: signingKeys.next,
      next: await generateSigningKey(),
    };
  }

  if (encryptionKeys) {
    // Rotate encryption keys: current -> previous
    encryptionKeys = {
      previous: encryptionKeys.current,
      current: await generateEncryptionKey(),
    };
  }

  // Save rotated keys
  const keysPath = getKeysPath();
  if (keysPath) {
    await saveKeysToFile(keysPath);
  }

  console.log('Key rotation complete');
}

// Initialize keys with lock to prevent concurrent initialization
async function initializeKeys(): Promise<void> {
  // Use promise-based lock to prevent race conditions
  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitializeKeys();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doInitializeKeys(): Promise<void> {
  const keysPath = getKeysPath();
  const jwsEnabled = isJwsEnabled();
  const jweEnabled = isJweEnabled();

  // Try to load from file
  if (keysPath) {
    const stored = await loadKeysFromFile(keysPath);
    if (stored) {
      const sigAlg = getSigningAlgorithm();
      const encAlg = getEncryptionAlgorithm();

      // Load signing keys if present and JWS is enabled
      if (jwsEnabled && stored.signing) {
        signingKeys = {
          next: await deserializeKey(stored.signing.next, sigAlg),
          current: await deserializeKey(stored.signing.current, sigAlg),
          previous: stored.signing.previous
            ? await deserializeKey(stored.signing.previous, sigAlg)
            : null,
        };
      }

      // Load encryption keys if present and JWE is enabled
      if (jweEnabled && stored.encryption) {
        encryptionKeys = {
          current: await deserializeKey(stored.encryption.current, encAlg),
          previous: stored.encryption.previous
            ? await deserializeKey(stored.encryption.previous, encAlg)
            : null,
        };
      }

      console.log('Keys loaded from:', keysPath);

      // Check if rotation is needed
      if (shouldRotate(stored.lastRotation)) {
        await rotateKeys();
      }

      // Generate missing keys if a feature was just enabled
      let needsSave = false;
      if (jwsEnabled && !signingKeys) {
        const [sigNext, sigCurrent] = await Promise.all([
          generateSigningKey(),
          generateSigningKey(),
        ]);
        signingKeys = { next: sigNext, current: sigCurrent, previous: null };
        needsSave = true;
      }
      if (jweEnabled && !encryptionKeys) {
        encryptionKeys = { current: await generateEncryptionKey(), previous: null };
        needsSave = true;
      }
      if (needsSave) {
        await saveKeysToFile(keysPath);
      }

      return;
    }
  }

  // Generate new keys only for enabled features
  console.log('Generating new key sets...');

  const promises: Promise<KeyWithMetadata>[] = [];
  if (jwsEnabled) {
    promises.push(generateSigningKey(), generateSigningKey());
  }
  if (jweEnabled) {
    promises.push(generateEncryptionKey());
  }

  const keys = await Promise.all(promises);
  let idx = 0;

  if (jwsEnabled) {
    signingKeys = {
      next: keys[idx++],
      current: keys[idx++],
      previous: null,
    };
  }

  if (jweEnabled) {
    encryptionKeys = {
      current: keys[idx++],
      previous: null,
    };
  }

  // Save to file
  if (keysPath) {
    await saveKeysToFile(keysPath);
  } else {
    console.warn('JWE_KEYS_PATH not set - keys will be regenerated on restart');
  }
}

// Public API
export async function getSigningKeys(): Promise<SigningKeySet | null> {
  if (!isJwsEnabled()) {
    return null;
  }

  // Check for rotation periodically (every hour)
  const now = Date.now();
  if (signingKeys && now - lastRotationCheck > 60 * 60 * 1000) {
    lastRotationCheck = now;
    const keysPath = getKeysPath();
    if (keysPath) {
      const stored = await loadKeysFromFile(keysPath);
      if (stored && shouldRotate(stored.lastRotation)) {
        await rotateKeys();
      }
    }
  }

  if (!signingKeys) {
    await initializeKeys();
  }

  return signingKeys;
}

export async function getEncryptionKeys(): Promise<EncryptionKeySet | null> {
  if (!isJweEnabled()) {
    return null;
  }

  // Check for rotation periodically (every hour)
  const now = Date.now();
  if (encryptionKeys && now - lastRotationCheck > 60 * 60 * 1000) {
    lastRotationCheck = now;
    const keysPath = getKeysPath();
    if (keysPath) {
      const stored = await loadKeysFromFile(keysPath);
      if (stored && shouldRotate(stored.lastRotation)) {
        await rotateKeys();
      }
    }
  }

  if (!encryptionKeys) {
    await initializeKeys();
  }

  return encryptionKeys;
}

/**
 * Get all private keys that can decrypt tokens.
 * Includes current and previous encryption keys.
 */
export async function getDecryptionKeys(): Promise<KeyWithMetadata[]> {
  const keys = await getEncryptionKeys();
  if (!keys) return [];

  const result = [keys.current];
  if (keys.previous) {
    result.push(keys.previous);
  }
  return result;
}

/**
 * Get the current signing key for creating signatures.
 */
export async function getCurrentSigningKey(): Promise<KeyWithMetadata | null> {
  const keys = await getSigningKeys();
  return keys?.current ?? null;
}

/**
 * Get all public keys that can verify signatures.
 * Includes next, current, and previous signing keys.
 */
export async function getVerificationKeys(): Promise<KeyWithMetadata[]> {
  const keys = await getSigningKeys();
  if (!keys) return [];

  const result = [keys.next, keys.current];
  if (keys.previous) {
    result.push(keys.previous);
  }
  return result;
}

/**
 * Get the public JWKS for publication.
 * Signing: all 3 keys (next, current, previous)
 * Encryption: only current key
 */
export async function getPublicJWKS(): Promise<{ keys: object[] }> {
  const jwks: object[] = [];

  // Add signing keys (all 3)
  if (isJwsEnabled()) {
    const sigKeys = await getSigningKeys();
    if (sigKeys) {
      const sigAlg = getSigningAlgorithm();

      // Add in order: current, next, previous (current first for priority)
      for (const key of [sigKeys.current, sigKeys.next, sigKeys.previous]) {
        if (key) {
          const publicJwk = await exportJWK(key.publicKey);
          jwks.push({
            ...publicJwk,
            kid: key.kid,
            use: 'sig',
            alg: sigAlg,
          });
        }
      }
    }
  }

  // Add encryption key (only current)
  if (isJweEnabled()) {
    const encKeys = await getEncryptionKeys();
    if (encKeys) {
      const encAlg = getEncryptionAlgorithm();
      const publicJwk = await exportJWK(encKeys.current.publicKey);
      jwks.push({
        ...publicJwk,
        kid: encKeys.current.kid,
        use: 'enc',
        alg: encAlg,
      });
    }
  }

  return { keys: jwks };
}

/**
 * Force key rotation (for manual rotation or testing)
 */
export async function forceRotation(): Promise<void> {
  // Initialize if needed for enabled features
  if ((!signingKeys && isJwsEnabled()) || (!encryptionKeys && isJweEnabled())) {
    await initializeKeys();
  }
  await rotateKeys();
}

/**
 * Clear all cached keys (for testing)
 */
export function clearKeysCache(): void {
  signingKeys = null;
  encryptionKeys = null;
  lastRotationCheck = 0;
  initPromise = null;
}
