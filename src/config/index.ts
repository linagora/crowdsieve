import { z } from 'zod';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * Interpolate environment variables in a string
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // Return empty string if no value and no default
    return '';
  });
}

/**
 * Recursively process an object and interpolate environment variables in string values
 */
function processEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(processEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = processEnvVars(value);
    }
    return result;
  }
  return obj;
}

// Filter rule schema
const BaseFilterSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

// Expression filter schema
// Primitive value types
const PrimitiveValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// Array of primitives or strings (for 'in', 'cidr', etc.)
const ValueArray = z.array(z.union([z.string(), z.number(), z.boolean()]));

// Field condition operators
const FieldOperator = z.enum([
  'eq', // equals
  'ne', // not equals
  'gt', // greater than
  'gte', // greater than or equal
  'lt', // less than
  'lte', // less than or equal
  'in', // value in array
  'not_in', // value not in array
  'contains', // string/array contains
  'not_contains', // string/array does not contain
  'starts_with', // string starts with
  'ends_with', // string ends with
  'empty', // array/string/null is empty
  'not_empty', // array/string is not empty
  'glob', // glob pattern match
  'regex', // regex pattern match
  'cidr', // IP in CIDR range(s)
]);

// Base condition for field operations
const FieldConditionSchema = z.object({
  field: z.string(),
  op: FieldOperator,
  value: z.union([PrimitiveValue, ValueArray]).optional(),
});

// Recursive expression type for logical operators
type ExpressionCondition =
  | z.infer<typeof FieldConditionSchema>
  | { op: 'and'; conditions: ExpressionCondition[] }
  | { op: 'or'; conditions: ExpressionCondition[] }
  | { op: 'not'; condition: ExpressionCondition };

// Recursive schema using z.lazy
const ExpressionConditionSchema: z.ZodType<ExpressionCondition> = z.lazy(() =>
  z.union([
    FieldConditionSchema,
    z.object({
      op: z.literal('and'),
      conditions: z.array(ExpressionConditionSchema).min(1),
    }),
    z.object({
      op: z.literal('or'),
      conditions: z.array(ExpressionConditionSchema).min(1),
    }),
    z.object({
      op: z.literal('not'),
      condition: ExpressionConditionSchema,
    }),
  ])
);

const FilterRuleSchema = BaseFilterSchema.extend({
  filter: ExpressionConditionSchema,
});

export type ExpressionConditionType = ExpressionCondition;
export type FilterRule = z.infer<typeof FilterRuleSchema>;

// LAPI server configuration
// - api_key: for bouncer (read-only) operations like querying decisions
// - machine_id + password: for machine (write) operations like posting alerts/bans
const LapiServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  api_key: z.string().min(1), // Bouncer API key for reading decisions
  machine_id: z.string().min(1).optional(), // Machine ID for posting alerts
  password: z.string().min(1).optional(), // Machine password for posting alerts
});

export type LapiServer = z.infer<typeof LapiServerSchema>;

// PostgreSQL configuration schema
const PostgresConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().default(5432),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ssl: z.boolean().default(false),
  ssl_reject_unauthorized: z.boolean().default(true), // Set to false only for self-signed certs
  pool_size: z.number().default(10),
});

export type PostgresConfig = z.infer<typeof PostgresConfigSchema>;

const ConfigSchema = z.object({
  proxy: z.object({
    listen_port: z.number().default(8080),
    capi_url: z.string().url().default('https://api.crowdsec.net'),
    timeout_ms: z.number().default(30000),
    forward_enabled: z.boolean().default(true),
  }),
  lapi_servers: z.array(LapiServerSchema).default([]),
  storage: z.object({
    type: z.enum(['sqlite', 'postgres']).default('sqlite'),
    path: z.string().default('./data/crowdsieve.db'),
    retention_days: z.number().default(30),
    postgres: PostgresConfigSchema.optional(),
  }),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      format: z.enum(['json', 'pretty']).default('json'),
    })
    .default({}),
  filters: z
    .object({
      mode: z.enum(['block', 'allow']).default('block'),
      rules: z.array(FilterRuleSchema).default([]),
    })
    .default({}),
  client_validation: z
    .object({
      enabled: z.boolean().default(false),
      cache_ttl_seconds: z.number().positive().default(604800),
      cache_ttl_error_seconds: z.number().positive().default(3600),
      validation_timeout_ms: z.number().positive().default(5000),
      max_memory_entries: z.number().positive().default(1000),
      fail_closed: z.boolean().default(false),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath: string): Config {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    // Interpolate environment variables in config values
    const processed = processEnvVars(parsed);
    return ConfigSchema.parse(processed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config file doesn't exist, use defaults
      return ConfigSchema.parse({});
    }
    throw error;
  }
}

export function loadConfigFromEnv(): Partial<Config> {
  // Build PostgreSQL config only if any POSTGRES_* env vars are set
  const hasPostgresConfig =
    process.env.POSTGRES_HOST ||
    process.env.POSTGRES_DATABASE ||
    process.env.POSTGRES_USER ||
    process.env.POSTGRES_PASSWORD;

  const postgresConfig = hasPostgresConfig
    ? {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: process.env.POSTGRES_DATABASE,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl: process.env.POSTGRES_SSL === 'true',
        ssl_reject_unauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false', // default true
        pool_size: parseInt(process.env.POSTGRES_POOL_SIZE || '10', 10),
      }
    : undefined;

  return {
    proxy: {
      listen_port: parseInt(process.env.PROXY_PORT || '8080', 10),
      capi_url: process.env.CAPI_URL || 'https://api.crowdsec.net',
      timeout_ms: parseInt(process.env.PROXY_TIMEOUT_MS || '30000', 10),
      forward_enabled: process.env.FORWARD_ENABLED !== 'false',
    },
    storage: {
      type: (process.env.STORAGE_TYPE as 'sqlite' | 'postgres') || 'sqlite',
      path: process.env.DATABASE_PATH || './data/crowdsieve.db',
      retention_days: parseInt(process.env.RETENTION_DAYS || '30', 10),
      postgres: postgresConfig,
    },
    logging: {
      level: (process.env.LOG_LEVEL as Config['logging']['level']) || 'info',
      format: (process.env.LOG_FORMAT as Config['logging']['format']) || 'json',
    },
    client_validation: {
      enabled: process.env.CLIENT_VALIDATION_ENABLED === 'true',
      cache_ttl_seconds: parseInt(process.env.CLIENT_VALIDATION_CACHE_TTL || '604800', 10),
      cache_ttl_error_seconds: parseInt(
        process.env.CLIENT_VALIDATION_CACHE_TTL_ERROR || '3600',
        10
      ),
      validation_timeout_ms: parseInt(process.env.CLIENT_VALIDATION_TIMEOUT_MS || '5000', 10),
      max_memory_entries: parseInt(process.env.CLIENT_VALIDATION_MAX_MEMORY_ENTRIES || '1000', 10),
      fail_closed: process.env.CLIENT_VALIDATION_FAIL_CLOSED === 'true',
    },
  };
}

export interface FilterLoadResult {
  filters: FilterRule[];
  errors: Array<{ file: string; error: string }>;
}

export function loadFiltersFromDirectory(dirPath: string): FilterLoadResult {
  const result: FilterLoadResult = { filters: [], errors: [] };

  if (!existsSync(dirPath)) {
    return result;
  }

  // Verify the path is a directory
  try {
    if (!statSync(dirPath).isDirectory()) {
      return result;
    }
  } catch {
    return result;
  }

  let files: string[];
  try {
    files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .filter((f) => !f.startsWith('_') && !f.startsWith('.'))
      .sort();
  } catch (error) {
    result.errors.push({
      file: dirPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(dirPath, file), 'utf-8');
      const parsed = parseYaml(content);
      const validated = FilterRuleSchema.parse(parsed);
      result.filters.push(validated);
    } catch (error) {
      result.errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
