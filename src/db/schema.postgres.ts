import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  serial,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const alerts = pgTable(
  'alerts',
  {
    id: serial('id').primaryKey(),

    // CrowdSec core fields
    uuid: text('uuid'),
    machineId: text('machine_id'),
    scenario: text('scenario').notNull(),
    scenarioHash: text('scenario_hash'),
    scenarioVersion: text('scenario_version'),
    message: text('message'),
    eventsCount: integer('events_count'),
    capacity: integer('capacity'),
    leakspeed: text('leakspeed'),

    // Timestamps
    startAt: text('start_at'),
    stopAt: text('stop_at'),
    createdAt: text('created_at'),
    receivedAt: text('received_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),

    // Flags (native boolean in PostgreSQL)
    simulated: boolean('simulated').default(false),
    remediation: boolean('remediation').default(false),
    hasDecisions: boolean('has_decisions').default(false),
    replicated: boolean('replicated').default(false),

    // Source information
    sourceScope: text('source_scope'),
    sourceValue: text('source_value'),
    sourceIp: text('source_ip'),
    sourceRange: text('source_range'),
    sourceAsNumber: text('source_as_number'),
    sourceAsName: text('source_as_name'),
    sourceCn: text('source_cn'),

    // GeoIP enrichment
    geoCountryCode: text('geo_country_code'),
    geoCountryName: text('geo_country_name'),
    geoCity: text('geo_city'),
    geoRegion: text('geo_region'),
    geoLatitude: doublePrecision('geo_latitude'),
    geoLongitude: doublePrecision('geo_longitude'),
    geoTimezone: text('geo_timezone'),
    geoIsp: text('geo_isp'),
    geoOrg: text('geo_org'),

    // Processing status
    filtered: boolean('filtered').default(false),
    filterReasons: text('filter_reasons'), // JSON array
    forwardedToCapi: boolean('forwarded_to_capi').default(false),
    forwardedAt: text('forwarded_at'),
    // Locally-recorded audit event flag. Set on rows inserted by CrowdSieve to
    // record a human action (currently: unban after a decision delete, manual
    // ban audit) that should appear in the timeline but never be forwarded to
    // CAPI and never counted in alert/decision statistics. The specific audit
    // kind is distinguished by `scenario` (`crowdsieve/unban`,
    // `crowdsieve/manual-audit`).
    localAudit: boolean('local_audit').default(false),
    // Identifier of the human user who triggered this alert/event (e.g. unban),
    // sourced from the dashboard OIDC session and forwarded as X-Crowdsieve-Actor.
    actor: text('actor'),

    // Raw data
    rawJson: text('raw_json'),
  },
  (table) => ({
    scenarioIdx: index('idx_scenario').on(table.scenario),
    sourceIpIdx: index('idx_source_ip').on(table.sourceIp),
    receivedAtIdx: index('idx_received_at').on(table.receivedAt),
    countryCodeIdx: index('idx_country_code').on(table.geoCountryCode),
    filteredIdx: index('idx_filtered').on(table.filtered),
    machineIdIdx: index('idx_machine_id').on(table.machineId),
    localAuditIdx: index('idx_local_audit').on(table.localAudit),
  })
);

export const decisions = pgTable(
  'decisions',
  {
    id: serial('id').primaryKey(),
    alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),

    uuid: text('uuid'),
    origin: text('origin'),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    value: text('value').notNull(),
    duration: text('duration'),
    scenario: text('scenario'),
    simulated: boolean('simulated').default(false),
    until: text('until'),
    createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    alertIdIdx: index('idx_decision_alert').on(table.alertId),
    valueIdx: index('idx_decision_value').on(table.value),
    typeIdx: index('idx_decision_type').on(table.type),
  })
);

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
    timestamp: text('timestamp'),
    meta: text('meta'), // JSON object
  },
  (table) => ({
    alertIdIdx: index('idx_event_alert').on(table.alertId),
  })
);

export const validatedClients = pgTable(
  'validated_clients',
  {
    id: serial('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    machineId: text('machine_id'),
    validatedAt: text('validated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastAccessedAt: text('last_accessed_at').notNull(),
    accessCount: integer('access_count').default(1),
  },
  (table) => ({
    // Note: tokenHash already has implicit index from UNIQUE constraint
    expiresAtIdx: index('idx_vc_expires_at').on(table.expiresAt),
  })
);

// Analyzer run history
export const analyzerRuns = pgTable(
  'analyzer_runs',
  {
    id: serial('id').primaryKey(),
    analyzerId: text('analyzer_id').notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    status: text('status').notNull(), // 'running', 'success', 'error'
    logsFetched: integer('logs_fetched').default(0),
    alertsGenerated: integer('alerts_generated').default(0),
    decisionsPushed: integer('decisions_pushed').default(0),
    errorMessage: text('error_message'),
    resultsJson: text('results_json'), // JSON array of detection results
    pushResultsJson: text('push_results_json'), // JSON array of push results
  },
  (table) => ({
    analyzerIdIdx: index('idx_analyzer_runs_analyzer_id').on(table.analyzerId),
    startedAtIdx: index('idx_analyzer_runs_started_at').on(table.startedAt),
  })
);

// Analyzer detection results (individual alerts)
export const analyzerResults = pgTable(
  'analyzer_results',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => analyzerRuns.id, { onDelete: 'cascade' }),
    sourceIp: text('source_ip').notNull(),
    distinctCount: integer('distinct_count').notNull(),
    totalCount: integer('total_count').notNull(),
    firstSeen: text('first_seen'),
    lastSeen: text('last_seen'),
    decisionPushed: boolean('decision_pushed').default(false),
    decisionId: text('decision_id'), // ID returned by LAPI
  },
  (table) => ({
    runIdIdx: index('idx_analyzer_results_run_id').on(table.runId),
    sourceIpIdx: index('idx_analyzer_results_source_ip').on(table.sourceIp),
  })
);

// Bouncer registry — quasi-static metadata per (lapi, bouncer, kind).
// Mirrors the SQLite `bouncers` table.
export const bouncers = pgTable(
  'bouncers',
  {
    lapiServerName: text('lapi_server_name').notNull(),
    bouncerName: text('bouncer_name').notNull(),
    componentKind: text('component_kind').notNull(),
    bouncerType: text('bouncer_type'),
    osName: text('os_name'),
    osVersion: text('os_version'),
    version: text('version'),
    firstSeenAt: bigint('first_seen_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.lapiServerName, table.bouncerName, table.componentKind],
    }),
  })
);

// Bouncer usage-metrics snapshots polled from LAPI /v1/usage-metrics.
// Mirrors the SQLite schema in src/db/schema.ts; collectedAt is a unix-ms bigint
// stored as PostgreSQL bigint (drizzle's `integer` maps to int4, so we use
// bigint here via the `bigint` column with `mode: 'number'`). Bouncer metadata
// (OS, version, type) lives in the `bouncers` table — joined back at read time.
export const bouncerMetrics = pgTable(
  'bouncer_metrics',
  {
    id: serial('id').primaryKey(),
    lapiServerName: text('lapi_server_name').notNull(),
    componentKind: text('component_kind').notNull(), // 'remediation' | 'log_processor'
    bouncerName: text('bouncer_name').notNull(),
    activeDecisions: integer('active_decisions'),
    processedItems: integer('processed_items'),
    droppedItems: integer('dropped_items'),
    bytesProcessed: integer('bytes_processed'),
    collectedAt: bigint('collected_at', { mode: 'number' }).notNull(),
    metricsJson: text('metrics_json').notNull(),
  },
  (table) => ({
    serverCollectedIdx: index('idx_bouncer_metrics_server_collected').on(
      table.lapiServerName,
      table.collectedAt
    ),
    bouncerCollectedIdx: index('idx_bouncer_metrics_bouncer_collected').on(
      table.bouncerName,
      table.collectedAt
    ),
    // Deduplication: CrowdSec LAPI may re-relay the same usage-metrics block
    // (same `meta.utc_now_timestamp`, hence same collectedAt). The unique
    // index combined with `ON CONFLICT DO NOTHING` (see saveBouncerMetrics)
    // keeps per-window counters from being double-counted on retries.
    uniqueSnapshotIdx: uniqueIndex('bouncer_metrics_unique').on(
      table.lapiServerName,
      table.bouncerName,
      table.componentKind,
      table.collectedAt
    ),
  })
);

// Types for inserting
export type InsertAlert = typeof alerts.$inferInsert;
export type SelectAlert = typeof alerts.$inferSelect;
export type InsertDecision = typeof decisions.$inferInsert;
export type SelectDecision = typeof decisions.$inferSelect;
export type InsertValidatedClient = typeof validatedClients.$inferInsert;
export type SelectValidatedClient = typeof validatedClients.$inferSelect;
export type InsertAnalyzerRun = typeof analyzerRuns.$inferInsert;
export type SelectAnalyzerRun = typeof analyzerRuns.$inferSelect;
export type InsertAnalyzerResult = typeof analyzerResults.$inferInsert;
export type SelectAnalyzerResult = typeof analyzerResults.$inferSelect;
export type InsertBouncerMetric = typeof bouncerMetrics.$inferInsert;
export type SelectBouncerMetric = typeof bouncerMetrics.$inferSelect;
export type InsertBouncer = typeof bouncers.$inferInsert;
export type SelectBouncer = typeof bouncers.$inferSelect;
