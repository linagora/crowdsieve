import { z } from 'zod';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// Filter rule schema
const BaseFilterSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

// Expression filter schema
// Primitive value types
const PrimitiveValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

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
      conditions: z.array(ExpressionConditionSchema),
    }),
    z.object({
      op: z.literal('or'),
      conditions: z.array(ExpressionConditionSchema),
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

const ConfigSchema = z.object({
  proxy: z.object({
    listen_port: z.number().default(8080),
    capi_url: z.string().url().default('https://api.crowdsec.net'),
    timeout_ms: z.number().default(30000),
    forward_enabled: z.boolean().default(true),
  }),
  storage: z.object({
    path: z.string().default('./data/crowdsieve.db'),
    retention_days: z.number().default(30),
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
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath: string): Config {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    return ConfigSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config file doesn't exist, use defaults
      return ConfigSchema.parse({});
    }
    throw error;
  }
}

export function loadConfigFromEnv(): Partial<Config> {
  return {
    proxy: {
      listen_port: parseInt(process.env.PROXY_PORT || '8080', 10),
      capi_url: process.env.CAPI_URL || 'https://api.crowdsec.net',
      timeout_ms: parseInt(process.env.PROXY_TIMEOUT_MS || '30000', 10),
      forward_enabled: process.env.FORWARD_ENABLED !== 'false',
    },
    storage: {
      path: process.env.DATABASE_PATH || './data/crowdsieve.db',
      retention_days: parseInt(process.env.RETENTION_DAYS || '30', 10),
    },
    logging: {
      level: (process.env.LOG_LEVEL as Config['logging']['level']) || 'info',
      format: (process.env.LOG_FORMAT as Config['logging']['format']) || 'json',
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

  const files = readdirSync(dirPath)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter((f) => !f.startsWith('_') && !f.startsWith('.'))
    .sort();

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
