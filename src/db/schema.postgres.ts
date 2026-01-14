import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  serial,
  index,
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

// Types for inserting
export type InsertAlert = typeof alerts.$inferInsert;
export type SelectAlert = typeof alerts.$inferSelect;
export type InsertDecision = typeof decisions.$inferInsert;
export type SelectDecision = typeof decisions.$inferSelect;
export type InsertValidatedClient = typeof validatedClients.$inferInsert;
export type SelectValidatedClient = typeof validatedClients.$inferSelect;
