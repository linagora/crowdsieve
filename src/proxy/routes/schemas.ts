/**
 * Reusable TypeBox schemas for the proxy API.
 *
 * These schemas are consumed by Fastify v5 via @fastify/type-provider-typebox
 * and are exposed via @fastify/swagger for OpenAPI 3.x documentation.
 *
 * Conventions
 * -----------
 * - All response error shapes use {@link ErrorResponse}.
 * - Nullable string/number/boolean fields use {@link Nullable} so that the
 *   generated OpenAPI document includes both the value type and `null` rather
 *   than dropping nullability.
 * - Permissive object schemas (additionalProperties: true) are intentionally
 *   used for upstream LAPI/CAPI passthrough payloads we do not fully control.
 */

import { Type, type TSchema } from '@sinclair/typebox';

/**
 * Helper that turns a TypeBox schema into a nullable variant.
 * Equivalent to `T | null` in TypeScript.
 */
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// --- Primitive / shared field schemas ----------------------------------------

export const ErrorResponse = Type.Object({
  error: Type.String(),
});

export const ErrorWithMessageResponse = Type.Object({
  error: Type.String(),
  message: Type.Optional(Type.String()),
});

export const SuccessResponse = Type.Object({
  success: Type.Boolean(),
  message: Type.Optional(Type.String()),
  server: Type.Optional(Type.String()),
});

/** ISO 3166-1 alpha-2 country code */
export const CountryCode = Type.String({
  pattern: '^[A-Z]{2}$',
  description: 'ISO 3166-1 alpha-2 country code',
});

/** Machine ID — alphanumerics plus `_`, `-`, `.`, `:` (max 255 chars) */
export const MachineId = Type.String({
  pattern: '^[a-zA-Z0-9_\\-.:]+$',
  maxLength: 255,
});

/** Decision duration in `<digits>[smh]` format */
export const Duration = Type.String({
  pattern: '^\\d+[smh]$',
  description: 'Duration like 30s, 5m, 4h, 24h',
});

/** LAPI server name — alphanumerics plus `_` and `-` */
export const ServerName = Type.String({
  pattern: '^[a-zA-Z0-9_-]+$',
});

/** ISO 8601 date-time string (validated by Ajv `date-time` format) */
export const IsoDate = Type.String({
  format: 'date-time',
  description: 'ISO 8601 date-time string',
});

/** Statistics period selector */
export const Period = Type.Optional(
  Type.Union([Type.Literal('7d'), Type.Literal('30d'), Type.Literal('all')], {
    description: 'Lookback window: 7 days, 30 days, or all-time',
  })
);

// --- Alert response (mirrors src/db/schema.ts SelectAlert) -------------------

/**
 * Single alert as stored and returned by the dashboard API.
 *
 * Shape mirrors the SelectAlert type from src/db/schema.ts. All fields except
 * `id`, `scenario`, and `receivedAt` may be null because the source CrowdSec
 * payload sometimes omits them or GeoIP enrichment fails.
 */
export const AlertResponse = Type.Object({
  id: Type.Integer(),

  // CrowdSec core fields
  uuid: Nullable(Type.String()),
  machineId: Nullable(Type.String()),
  scenario: Type.String(),
  scenarioHash: Nullable(Type.String()),
  scenarioVersion: Nullable(Type.String()),
  message: Nullable(Type.String()),
  eventsCount: Nullable(Type.Integer()),
  capacity: Nullable(Type.Integer()),
  leakspeed: Nullable(Type.String()),

  // Timestamps
  startAt: Nullable(Type.String()),
  stopAt: Nullable(Type.String()),
  createdAt: Nullable(Type.String()),
  receivedAt: Type.String(),

  // Flags
  simulated: Nullable(Type.Boolean()),
  remediation: Nullable(Type.Boolean()),
  hasDecisions: Nullable(Type.Boolean()),
  replicated: Nullable(Type.Boolean()),

  // Source information
  sourceScope: Nullable(Type.String()),
  sourceValue: Nullable(Type.String()),
  sourceIp: Nullable(Type.String()),
  sourceRange: Nullable(Type.String()),
  sourceAsNumber: Nullable(Type.String()),
  sourceAsName: Nullable(Type.String()),
  sourceCn: Nullable(Type.String()),

  // GeoIP enrichment
  geoCountryCode: Nullable(Type.String()),
  geoCountryName: Nullable(Type.String()),
  geoCity: Nullable(Type.String()),
  geoRegion: Nullable(Type.String()),
  geoLatitude: Nullable(Type.Number()),
  geoLongitude: Nullable(Type.Number()),
  geoTimezone: Nullable(Type.String()),
  geoIsp: Nullable(Type.String()),
  geoOrg: Nullable(Type.String()),

  // Processing status
  filtered: Nullable(Type.Boolean()),
  filterReasons: Nullable(Type.String()),
  forwardedToCapi: Nullable(Type.Boolean()),
  forwardedAt: Nullable(Type.String()),

  // Raw data
  rawJson: Nullable(Type.String()),
});

// --- Stats responses (mirror interfaces in src/storage/index.ts) -------------

const ScenarioCount = Type.Object({
  scenario: Type.String(),
  count: Type.Integer(),
});

const CountryCount = Type.Object({
  country: Type.String(),
  count: Type.Integer(),
});

const CountryWithName = Type.Object({
  countryCode: Type.String(),
  countryName: Type.String(),
  count: Type.Integer(),
});

const DayBucket = Type.Object({
  day: Type.Integer(),
  dayName: Type.String(),
  count: Type.Integer(),
});

const HourBucket = Type.Object({
  hour: Type.Integer(),
  count: Type.Integer(),
});

const DurationBucket = Type.Object({
  category: Type.String(),
  count: Type.Integer(),
});

const DailyTrendPoint = Type.Object({
  date: Type.String(),
  count: Type.Integer(),
});

export const StatsResponse = Type.Object({
  total: Type.Integer(),
  filtered: Type.Integer(),
  forwarded: Type.Integer(),
  topScenarios: Type.Array(ScenarioCount),
  topCountries: Type.Array(CountryCount),
  timeBounds: Type.Object({
    min: Nullable(Type.String()),
    max: Nullable(Type.String()),
  }),
});

export const TimeDistributionResponse = Type.Object({
  byDayOfWeek: Type.Array(DayBucket),
  byHourOfDay: Type.Array(HourBucket),
  byCountry: Type.Array(CountryWithName),
  byScenario: Type.Array(ScenarioCount),
  dailyTrend: Type.Array(DailyTrendPoint),
  totalAlerts: Type.Integer(),
  dateRange: Type.Object({
    from: Nullable(Type.String()),
    to: Nullable(Type.String()),
  }),
});

export const DecisionStatsResponse = Type.Object({
  totalDecisions: Type.Integer(),
  byDayOfWeek: Type.Array(DayBucket),
  byHourOfDay: Type.Array(HourBucket),
  byDurationCategory: Type.Array(DurationBucket),
  topScenarios: Type.Array(ScenarioCount),
  byCountry: Type.Array(CountryWithName),
});

// --- LAPI server / decisions schemas -----------------------------------------

export const LapiServerInfo = Type.Object({
  name: Type.String(),
  url: Type.String(),
  canBan: Type.Boolean(),
});

/**
 * A single LAPI decision. We use additionalProperties: true because the
 * upstream LAPI may add fields we do not enumerate.
 */
export const LapiDecision = Type.Object(
  {
    id: Type.Integer(),
    origin: Type.String(),
    type: Type.String(),
    scope: Type.String(),
    value: Type.String(),
    duration: Type.String(),
    scenario: Type.String(),
    until: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

export const DecisionsServerResult = Type.Object({
  server: Type.String(),
  decisions: Type.Array(LapiDecision),
  error: Type.Optional(Type.String()),
});

export const DecisionsResponse = Type.Object({
  ip: Type.String(),
  results: Type.Array(DecisionsServerResult),
  shared: Type.Array(LapiDecision),
});

// --- IP info (matches IPInfo from src/ipinfo/index.ts) -----------------------

const WhoisSummarySchema = Type.Object({
  netName: Type.Optional(Type.String()),
  netRange: Type.Optional(Type.String()),
  cidr: Type.Optional(Type.String()),
  organization: Type.Optional(Type.String()),
  country: Type.Optional(Type.String()),
  descr: Type.Optional(Type.String()),
  abuse: Type.Optional(Type.String()),
});

export const IPInfoResponse = Type.Object({
  ip: Type.String(),
  reverseDns: Type.Array(Type.String()),
  whois: Nullable(WhoisSummarySchema),
  error: Type.Optional(Type.String()),
});

// --- Analyzer schemas --------------------------------------------------------

/**
 * Permissive AnalyzerStatus shape. The lastRun field embeds detection results
 * and push results whose shapes are not part of the public API contract, so
 * we use additionalProperties: true rather than enumerating internals.
 */
export const AnalyzerStatusSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    enabled: Type.Boolean(),
    lastRun: Type.Optional(Type.Object({}, { additionalProperties: true })),
    nextRun: Type.Optional(Type.String()),
    intervalMs: Type.Integer(),
  },
  { additionalProperties: true }
);

export const AnalyzersListResponse = Type.Object({
  enabled: Type.Boolean(),
  analyzers: Type.Array(AnalyzerStatusSchema),
});

export const AnalyzerDetailResponse = Type.Object({
  analyzer: Type.Object({}, { additionalProperties: true }),
  status: Type.Optional(AnalyzerStatusSchema),
});

export const AnalyzerRunsResponse = Type.Object({
  runs: Type.Array(Type.Object({}, { additionalProperties: true })),
});

export const AnalyzerRunTriggerResponse = Type.Object({
  success: Type.Boolean(),
  result: Type.Object({}, { additionalProperties: true }),
});

// --- Health ------------------------------------------------------------------

export const HealthResponse = Type.Object({
  status: Type.String(),
  timestamp: Type.String(),
});

// --- Signals -----------------------------------------------------------------

/**
 * Permissive Alert body schema for /v2/signals and /v3/signals.
 *
 * The CrowdSec Alert object is large and externally controlled; we only need
 * to validate that the request body is a bounded array of objects.
 */
export const SignalsBody = Type.Array(Type.Object({}, { additionalProperties: true }), {
  maxItems: 1000,
});

export const SignalsResponse = Type.Object({
  message: Type.String(),
});
