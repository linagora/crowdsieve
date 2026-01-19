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

// Duration regex: matches patterns like "3h", "30m", "24h", "7d"
const DurationRegex = /^\d+[smhd]$/;

// Source type schema - only Loki supported for now
const LokiSourceSchema = z.object({
  type: z.literal('loki'),
  grafana_url: z.string().url(),
  token: z.string().min(1),
  datasource_uid: z.string().min(1),
});

export type LokiSource = z.infer<typeof LokiSourceSchema>;

// Union of all source types (extensible for future sources)
const SourceSchema = LokiSourceSchema;
export type Source = z.infer<typeof SourceSchema>;

// Schedule schema for analyzers
const ScheduleSchema = z.object({
  interval: z
    .string()
    .regex(DurationRegex, 'Invalid duration format (use: 30m, 3h, 1d)')
    .default('3h'),
  lookback: z
    .string()
    .regex(DurationRegex, 'Invalid duration format (use: 30m, 3h, 1d)')
    .default('3h'),
});

export type Schedule = z.infer<typeof ScheduleSchema>;

// Source reference in analyzer config
const SourceRefSchema = z.object({
  ref: z.string().min(1), // Reference to global source name
  query: z.string().min(1), // LogQL query
  max_lines: z.number().positive().default(5000),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;

// Field extraction schema
const ExtractionSchema = z.object({
  format: z.enum(['json']).default('json'), // Only JSON for now
  fields: z.record(z.string()).refine((fields) => Object.keys(fields).length > 0, {
    message: 'At least one field must be defined',
  }),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// Detection schema
const DetectionSchema = z.object({
  groupby: z.string().min(1), // Field to group by (e.g., "source_ip")
  distinct: z.string().min(1).optional(), // Field to count distinct values
  threshold: z.number().positive(), // Alert threshold
  operator: z.enum(['>', '>=', '<', '<=', '==']).default('>='),
});

export type Detection = z.infer<typeof DetectionSchema>;

// Decision schema
const DecisionSchema = z.object({
  type: z.enum(['ban', 'captcha']).default('ban'),
  duration: z.string().regex(DurationRegex, 'Invalid duration format (use: 4h, 24h, 168h)'),
  scope: z.enum(['ip', 'range']).default('ip'),
  scenario: z.string().min(1),
  reason: z.string().min(1),
});

export type Decision = z.infer<typeof DecisionSchema>;

// Complete analyzer configuration schema
const AnalyzerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  version: z.string().default('1.0.0'),

  schedule: ScheduleSchema.default({}),
  source: SourceRefSchema,
  extraction: ExtractionSchema,
  detection: DetectionSchema,
  decision: DecisionSchema,

  // Targets: "all" or list of specific LAPI server names
  targets: z.array(z.string()).default(['all']),
});

export type AnalyzerConfig = z.infer<typeof AnalyzerConfigSchema>;

// Global analyzers section in filters.yaml
const AnalyzersGlobalConfigSchema = z.object({
  enabled: z.boolean().default(false),
  config_dir: z.string().default('./config/analyzers.d'),
  default_interval: z.string().regex(DurationRegex).default('3h'),
  default_lookback: z.string().regex(DurationRegex).default('3h'),
  default_targets: z.union([z.literal('all'), z.array(z.string())]).default('all'),
  // Global whitelist: IPs and CIDR ranges to ignore in all analyzers
  whitelist: z.array(z.string()).default([]),
  sources: z.record(SourceSchema).default({}),
});

export type AnalyzersGlobalConfig = z.infer<typeof AnalyzersGlobalConfigSchema>;

/**
 * Parse a duration string (e.g., "3h", "30m", "1d") to milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Parse a duration string to Loki-compatible relative time format
 */
export function durationToLokiFormat(duration: string): string {
  // Loki uses the same format, just ensure it's valid
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  return duration;
}

export interface AnalyzerLoadResult {
  analyzers: AnalyzerConfig[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Load analyzer configurations from a directory
 */
export function loadAnalyzersFromDirectory(dirPath: string): AnalyzerLoadResult {
  const result: AnalyzerLoadResult = { analyzers: [], errors: [] };

  if (!existsSync(dirPath)) {
    return result;
  }

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
      // Interpolate environment variables
      const processed = processEnvVars(parsed);
      const validated = AnalyzerConfigSchema.parse(processed);
      result.analyzers.push(validated);
    } catch (error) {
      result.errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Parse the global analyzers config section
 */
export function parseAnalyzersGlobalConfig(config: unknown): AnalyzersGlobalConfig {
  const processed = processEnvVars(config);
  return AnalyzersGlobalConfigSchema.parse(processed || {});
}

/**
 * Resolve a source reference to an actual source configuration
 */
export function resolveSource(ref: string, sources: Record<string, Source>): Source | null {
  return sources[ref] || null;
}
