export interface ValidationConfig {
  enabled: boolean;
  cacheTtlSeconds: number;
  cacheTtlErrorSeconds: number;
  validationTimeoutMs: number;
  maxMemoryEntries: number;
  failClosed: boolean;
}

export type ValidationReason =
  | 'no_auth_header'
  | 'invalid_credentials'
  | 'capi_rejected'
  | 'cached_memory'
  | 'cached_sqlite'
  | 'cached_failopen'
  | 'validated'
  | 'capi_error_failopen'
  | 'capi_error_failclosed';

export interface ValidationResult {
  /** Whether the request may proceed (true for real validations and fail-open). */
  valid: boolean;
  reason: ValidationReason;
  /**
   * True only when CAPI answered this exact Authorization header with a 2xx,
   * either now or within the cache TTL. A fail-open result (CAPI 5xx, timeout
   * or network error with `fail_closed: false`) is `valid` but NOT
   * authenticated, and must not be used to grant anything beyond plain
   * ingestion (e.g. decision replication).
   */
  authenticated: boolean;
}

export interface CacheEntry {
  tokenHash: string;
  expiresAt: Date;
  machineId?: string;
  /**
   * Set for fail-open entries. These live in the memory cache only and are
   * never reported as authenticated.
   */
  failOpen?: boolean;
}
