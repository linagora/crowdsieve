import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

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

    // Flags
    simulated: integer('simulated', { mode: 'boolean' }).default(false),
    remediation: integer('remediation', { mode: 'boolean' }).default(false),
    hasDecisions: integer('has_decisions', { mode: 'boolean' }).default(false),

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
    geoLatitude: real('geo_latitude'),
    geoLongitude: real('geo_longitude'),
    geoTimezone: text('geo_timezone'),
    geoIsp: text('geo_isp'),
    geoOrg: text('geo_org'),

    // Processing status
    filtered: integer('filtered', { mode: 'boolean' }).default(false),
    filterReasons: text('filter_reasons'), // JSON array
    forwardedToCapi: integer('forwarded_to_capi', { mode: 'boolean' }).default(false),
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

export const decisions = sqliteTable(
  'decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),

    uuid: text('uuid'),
    origin: text('origin'),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    value: text('value').notNull(),
    duration: text('duration'),
    scenario: text('scenario'),
    simulated: integer('simulated', { mode: 'boolean' }).default(false),
    until: text('until'),
    createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    alertIdIdx: index('idx_decision_alert').on(table.alertId),
    valueIdx: index('idx_decision_value').on(table.value),
    typeIdx: index('idx_decision_type').on(table.type),
  })
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
    timestamp: text('timestamp'),
    meta: text('meta'), // JSON object
  },
  (table) => ({
    alertIdIdx: index('idx_event_alert').on(table.alertId),
  })
);

export const validatedClients = sqliteTable(
  'validated_clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
