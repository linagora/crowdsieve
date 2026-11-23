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

import { Type, type TSchema } from 'typebox';

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

/** Decision type as stored by LAPI (`ban`, `captcha`, `throttle`, custom...) */
export const DecisionType = Type.String({
  pattern: '^[a-zA-Z0-9_-]+$',
  maxLength: 64,
  description: 'Decision type, e.g. ban or captcha',
});

/** Decision origin as stored by LAPI (`crowdsec`, `cscli`, `CAPI`, `lists`...) */
export const DecisionOrigin = Type.String({
  pattern: '^[a-zA-Z0-9_.:-]+$',
  maxLength: 64,
  description: 'Decision origin, e.g. crowdsec, cscli, crowdsieve, CAPI or lists',
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
// Note: explicit `TSchema` annotation prevents TypeScript's type-instantiation
// depth limit from being hit when this object is referenced in route schemas
// such as `Type.Array(AlertResponse)`. Without it, adding fields here can
// cause TS2589 ("Type instantiation is excessively deep and possibly infinite")
// at unrelated route handlers. This widening only affects the inferred TS type
// — the runtime TypeBox schema and OpenAPI generation are unaffected.
export const AlertResponse: TSchema = Type.Object({
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
  filterRules: Nullable(Type.String()),
  forwardedToCapi: Nullable(Type.Boolean()),
  forwardedAt: Nullable(Type.String()),
  localAudit: Nullable(Type.Boolean()),
  actor: Nullable(Type.String()),
  auditServer: Nullable(Type.String()),
  auditType: Nullable(Type.String()),
  auditDuration: Nullable(Type.String()),

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

const CountryWithOptionalName = Type.Object({
  country: Type.String({ description: 'ISO 3166-1 alpha-2 country code' }),
  countryName: Nullable(Type.String()),
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
  blockedRequests: Type.Integer(),
  topScenarios: Type.Array(ScenarioCount),
  allScenarios: Type.Array(ScenarioCount),
  topCountries: Type.Array(CountryCount),
  allCountries: Type.Array(CountryWithOptionalName),
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

// --- Filter rules ------------------------------------------------------------

/** A filter rule as loaded at startup (operator configuration). */
const FilterRuleInfo = Type.Object({
  name: Type.String(),
  description: Nullable(Type.String()),
  enabled: Type.Boolean(),
  file: Nullable(Type.String({ description: 'Name of the file the rule was loaded from' })),
  condition: Type.String({ description: 'The rule condition, as YAML' }),
});

export const FilterRulesResponse = Type.Object({
  mode: Type.Union([Type.Literal('block'), Type.Literal('allow')]),
  rules: Type.Array(FilterRuleInfo),
});

export const FilterRuleStatsResponse = Type.Object({
  total: Type.Integer(),
  filtered: Type.Integer(),
  byRule: Type.Array(
    Type.Object({
      name: Type.String(),
      count: Type.Integer(),
      lastMatchedAt: Nullable(Type.String()),
    })
  ),
});

export const FilterTestBody = Type.Object(
  { alertId: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);

export const FilterTestResponse = Type.Object({
  filtered: Type.Boolean(),
  matched: Type.Array(Type.Object({ name: Type.String(), reason: Nullable(Type.String()) })),
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

/** Remediation type of a manual ban. */
export const BanType = Type.Union([Type.Literal('ban'), Type.Literal('captcha')], {
  description: 'Remediation type of the decision (default: ban)',
});

// --- Audit log (mirrors AuditLogPage in src/storage/audit.ts) ----------------

export const AuditAction = Type.Union([Type.Literal('ban'), Type.Literal('unban')]);

export const AuditLogItem = Type.Object({
  id: Type.Integer({ description: 'Id of the audit row (alert detail page)' }),
  at: Type.String({ description: 'When the action was recorded (ISO 8601)' }),
  action: AuditAction,
  actor: Nullable(Type.String()),
  ip: Nullable(Type.String({ description: 'Targeted IP address or CIDR range' })),
  server: Nullable(Type.String({ description: 'LAPI server the action was sent to' })),
  type: Nullable(Type.String({ description: 'Remediation type of a ban; null for unbans' })),
  duration: Nullable(Type.String({ description: 'Duration of a ban; null for unbans' })),
  reason: Nullable(Type.String()),
});

export const AuditLogResponse = Type.Object({
  items: Type.Array(AuditLogItem),
  total: Type.Integer(),
});

export const AuditActorsResponse = Type.Object({
  actors: Type.Array(Type.String()),
});

export const ActiveDecisionsServerResult = Type.Object({
  server: Type.String(),
  decisions: Type.Array(LapiDecision),
  error: Type.Optional(Type.String()),
  /** Set when the server had more matching decisions than the per-server cap. */
  truncated: Type.Optional(Type.Boolean()),
  /** Number of matching decisions before the cap, when truncated. */
  total: Type.Optional(Type.Integer()),
});

export const ActiveDecisionsResponse = Type.Object({
  results: Type.Array(ActiveDecisionsServerResult),
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

// --- Usage metrics relay (LAPI -> CAPI) --------------------------------------

/**
 * Permissive body schema for POST /v1/usage-metrics. CrowdSec's payload nests
 * `remediation_components[]` and `log_processors[]`, each with a `metrics`
 * field whose shape varies between releases (sometimes a flat item array,
 * sometimes wrapped in `{ items: [...] }`). We don't constrain it here — the
 * route's parser handles both shapes — but we do require a JSON object.
 */
export const UsageMetricsBody = Type.Object({}, { additionalProperties: true });

// --- Bouncer metrics ---------------------------------------------------------

/**
 * One row of bouncer usage-metrics, mirroring the SelectBouncerMetric type
 * from src/db/schema.ts. `metricsJson` is the raw `metrics[]` array verbatim
 * for callers that want to drill into per-label values; the dashboard's
 * standard graphs only need the typed counters.
 */
export const BouncerMetricResponse = Type.Object({
  id: Type.Integer(),
  lapiServerName: Type.String(),
  componentKind: Type.String(),
  bouncerName: Type.String(),
  bouncerType: Nullable(Type.String()),
  osName: Nullable(Type.String()),
  osVersion: Nullable(Type.String()),
  version: Nullable(Type.String()),
  activeDecisions: Nullable(Type.Integer()),
  processedItems: Nullable(Type.Integer()),
  droppedItems: Nullable(Type.Integer()),
  bytesProcessed: Nullable(Type.Integer()),
  collectedAt: Type.Integer(),
  metricsJson: Type.String(),
});

export const BouncerNameRow = Type.Object({
  lapiServerName: Type.String(),
  bouncerName: Type.String(),
  bouncerType: Nullable(Type.String()),
  /** Unix ms of the last usage-metrics report (any component kind). */
  lastSeenAt: Type.Integer(),
  version: Nullable(Type.String()),
  osName: Nullable(Type.String()),
  osVersion: Nullable(Type.String()),
});

export const BouncerNamesResponse = Type.Object({
  bouncers: Type.Array(BouncerNameRow),
});

/** A decision of an alert, as shown on the alert detail. */
export const AlertDecisionResponse = Type.Object({
  id: Type.Integer(),
  type: Type.String(),
  scope: Type.String(),
  value: Type.String(),
  duration: Nullable(Type.String()),
  origin: Nullable(Type.String()),
  scenario: Nullable(Type.String()),
  until: Nullable(Type.String()),
  simulated: Nullable(Type.Boolean()),
});

/** One event of an alert: timestamp and meta key/value pairs. */
export const AlertEventResponse = Type.Object({
  timestamp: Nullable(Type.String()),
  meta: Type.Array(Type.Object({ key: Type.String(), value: Type.String() })),
});

/**
 * Single alert with its decisions and its first events. Every field of
 * {@link AlertResponse} is kept; `events` holds at most 50 entries and
 * `eventsTotal` the number of events in the stored payload.
 */
export const AlertDetailResponse: TSchema = Type.Object({
  ...(AlertResponse as unknown as { properties: Record<string, TSchema> }).properties,
  decisions: Type.Array(AlertDecisionResponse),
  events: Type.Array(AlertEventResponse),
  eventsTotal: Type.Integer(),
});

export const AlertRawResponse = Type.Object({
  rawJson: Type.String(),
});

// --- Status (CAPI forwarding and LAPI connectivity) ------------------------------

const TimedError = Nullable(Type.Object({ at: Type.Integer(), message: Type.String() }));

export const StatusResponse = Type.Object({
  ok: Type.Boolean(),
  problems: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal('capi'), Type.Literal('lapi')]),
      server: Type.Optional(Type.String()),
      since: Nullable(Type.Integer()),
      message: Type.String(),
    })
  ),
  capi: Type.Object({
    enabled: Type.Boolean(),
    state: Type.Union([
      Type.Literal('disabled'),
      Type.Literal('idle'),
      Type.Literal('ok'),
      Type.Literal('failing'),
    ]),
    lastSuccessAt: Nullable(Type.Integer()),
    lastError: TimedError,
    failingSince: Nullable(Type.Integer()),
    sent24h: Type.Integer(),
    failed24h: Type.Integer(),
  }),
  lapis: Type.Array(
    Type.Object({
      name: Type.String(),
      host: Type.String(),
      reachable: Nullable(Type.Boolean()),
      responseTimeMs: Nullable(Type.Integer()),
      error: Nullable(Type.String()),
      checkedAt: Nullable(Type.Integer()),
      unreachableSince: Nullable(Type.Integer()),
      machineCredentials: Type.Boolean(),
      machineAuth: Type.Union([
        Type.Literal('not_configured'),
        Type.Literal('ok'),
        Type.Literal('failed'),
        Type.Literal('unknown'),
      ]),
      manualBanAvailable: Type.Boolean(),
      replication: Type.Object({
        enabled: Type.Boolean(),
        lastError: TimedError,
        lastSuccessAt: Nullable(Type.Integer()),
      }),
    })
  ),
  generatedAt: Type.Integer(),
});

// --- Notifications (webhook targets) ---------------------------------------------

const NotificationEvent = Type.Union([
  Type.Literal('alert'),
  Type.Literal('manual_ban'),
  Type.Literal('unban'),
  Type.Literal('forwarding_error'),
  Type.Literal('lapi_error'),
]);

export const NotificationTargetName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9_-]+$',
  description: 'Name of a notification target',
});

export const NotificationsResponse = Type.Object({
  enabled: Type.Boolean(),
  dashboardUrl: Nullable(Type.String()),
  targets: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.Union([Type.Literal('webhook'), Type.Literal('slack')]),
      host: Type.String({ description: 'Host of the target URL (no path, query or credentials)' }),
      events: Type.Array(NotificationEvent),
      minInterval: Type.String(),
      minIntervalMs: Type.Integer(),
      match: Nullable(
        Type.Object({
          scenarios: Type.Array(Type.String()),
          countries: Type.Array(Type.String()),
          machines: Type.Array(Type.String()),
          status: Type.Union([
            Type.Literal('forwarded'),
            Type.Literal('filtered'),
            Type.Literal('any'),
          ]),
        })
      ),
      lastResult: Nullable(
        Type.Object({
          at: Type.Integer(),
          ok: Type.Boolean(),
          event: Type.Union([NotificationEvent, Type.Literal('test')]),
          message: Type.String(),
          attempts: Type.Integer(),
        })
      ),
      lastSuccessAt: Nullable(Type.Integer()),
      retrying: Nullable(
        Type.Object({
          attempt: Type.Integer(),
          maxAttempts: Type.Integer(),
          nextAttemptAt: Type.Integer(),
          message: Type.String(),
        })
      ),
      queued: Type.Integer(),
      buffered: Type.Integer(),
      dropped: Type.Integer(),
    })
  ),
});

export const NotificationTestResponse = Type.Object({
  ok: Type.Boolean(),
  message: Type.String(),
});
