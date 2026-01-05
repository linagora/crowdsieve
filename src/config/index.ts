import { z } from 'zod';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

// Filter rule schemas
const BaseFilterSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

const NoDecisionFilterSchema = BaseFilterSchema.extend({
  type: z.literal('no-decision'),
});

const SimulatedFilterSchema = BaseFilterSchema.extend({
  type: z.literal('simulated'),
});

const ScenarioFilterSchema = BaseFilterSchema.extend({
  type: z.literal('scenario'),
  patterns: z.array(z.string()),
  match_mode: z.enum(['exact', 'glob', 'regex']).default('glob'),
});

const SourceCountryFilterSchema = BaseFilterSchema.extend({
  type: z.literal('source-country'),
  mode: z.enum(['allowlist', 'blocklist']),
  countries: z.array(z.string()),
});

const SourceIpFilterSchema = BaseFilterSchema.extend({
  type: z.literal('source-ip'),
  mode: z.enum(['allowlist', 'blocklist']),
  cidrs: z.array(z.string()),
});

const FilterRuleSchema = z.discriminatedUnion('type', [
  NoDecisionFilterSchema,
  SimulatedFilterSchema,
  ScenarioFilterSchema,
  SourceCountryFilterSchema,
  SourceIpFilterSchema,
]);

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
