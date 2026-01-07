export interface ValidationConfig {
  enabled: boolean;
  cacheTtlSeconds: number;
  cacheTtlErrorSeconds: number;
  validationTimeoutMs: number;
  maxMemoryEntries: number;
}

export type ValidationReason =
  | 'no_auth_header'
  | 'invalid_credentials'
  | 'cached_memory'
  | 'cached_sqlite'
  | 'validated'
  | 'capi_error_failopen';

export interface ValidationResult {
  valid: boolean;
  reason: ValidationReason;
}

export interface CacheEntry {
  tokenHash: string;
  expiresAt: Date;
  machineId?: string;
}
