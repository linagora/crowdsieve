import { eq, desc, and, or, gt, gte, lte, like, sql } from 'drizzle-orm';
import net from 'net';
import type { Alert } from '../models/alert.js';
import type { FilterEngineResult } from '../filters/types.js';
import { getDatabaseContext } from '../db/index.js';
import type { GeoIPInfo } from '../models/alert.js';
import { extractIpFromValue } from '../ipinfo/index.js';
import { CROWDSIEVE_VERSION } from '../auth/machineToken.js';

/**
 * Escape SQL LIKE wildcards to prevent injection.
 * Backslash must be escaped FIRST to avoid double-escaping.
 */
function escapeLikePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, '\\\\') // Escape backslash first
    .replace(/[%_]/g, '\\$&'); // Then escape LIKE wildcards
}

/**
 * Maximum stored length of an actor identifier (matches MAX_ACTOR_LENGTH in
 * src/proxy/routes/api.ts). Kept here too so storage callers don't need to
 * cross the route boundary just to sanitize.
 */
const MAX_ACTOR_LENGTH = 256;

/**
 * Trim and truncate an actor value, returning null when the result is empty.
 * Centralizes the "store NULL instead of whitespace/empty" semantics used by
 * both `recordLocalAuditEvent` (unban / manual-ban audit) and the
 * `events[].meta` extraction path in storeAlerts.
 */
function sanitizeActor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_ACTOR_LENGTH);
}

/** Scenario string for unban audit rows recorded after a decision delete. */
export const UNBAN_AUDIT_SCENARIO = 'crowdsieve/unban';
/** Scenario string for manual ban audit rows recorded after a manual LAPI ban. */
export const MANUAL_BAN_AUDIT_SCENARIO = 'crowdsieve/manual-audit';

export interface AlertQuery {
  filtered?: boolean;
  forwardedToCapi?: boolean;
  scenario?: string;
  sourceCountry?: string;
  sourceIp?: string;
  machineId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface AlertStats {
  total: number;
  filtered: number;
  forwarded: number;
  /**
   * Total requests dropped by all bouncers over the last 30 days, computed as
   * the sum of `dropped_items` across every `componentKind='remediation'`
   * snapshot in the window. CrowdSec emits `dropped` as a per-window counter
   * (one block per `WindowSizeSeconds`, value scoped to that window only), so
   * a straight sum is the correct aggregation — no delta or reset detection
   * needed.
   * Returns 0 when bouncer metrics are disabled or no data is available.
   */
  blockedRequests: number;
  /**
   * Top 10 scenarios by count, excluding locally-recorded audit rows
   * (unban + manual-ban audit). Used by the stats panel.
   */
  topScenarios: Array<{ scenario: string; count: number }>;
  /**
   * Distinct scenarios present in the alerts table since `since`, with their
   * row counts. Includes locally-recorded audit rows (`crowdsieve/unban`,
   * `crowdsieve/manual-audit`). Not capped — used to populate the scenario
   * filter dropdown so every scenario the user has interacted with is
   * selectable.
   */
  allScenarios: Array<{ scenario: string; count: number }>;
  topCountries: Array<{ country: string; count: number }>;
  timeBounds: { min: string | null; max: string | null };
}

export interface TimeDistributionStats {
  byDayOfWeek: Array<{ day: number; dayName: string; count: number }>;
  byHourOfDay: Array<{ hour: number; count: number }>;
  byCountry: Array<{ countryCode: string; countryName: string; count: number }>;
  byScenario: Array<{ scenario: string; count: number }>;
  dailyTrend: Array<{ date: string; count: number }>;
  totalAlerts: number;
  dateRange: { from: string | null; to: string | null };
}

export interface DecisionStats {
  totalDecisions: number;
  byDayOfWeek: Array<{ day: number; dayName: string; count: number }>;
  byHourOfDay: Array<{ hour: number; count: number }>;
  byDurationCategory: Array<{ category: string; count: number }>;
  topScenarios: Array<{ scenario: string; count: number }>;
  byCountry: Array<{ countryCode: string; countryName: string; count: number }>;
}

// Import schema types - use SQLite schema types as canonical (they're compatible)
import type { SelectAlert, SelectBouncerMetric, InsertBouncerMetric } from '../db/schema.js';

// Public bouncer-metric shape: counters + collectedAt + the bouncer metadata
// joined back from the `bouncers` table. Storage hides the normalization from
// callers so route handlers and the dashboard see the same flat row as before.
export type BouncerMetric = SelectBouncerMetric & {
  bouncerType: string | null;
  osName: string | null;
  osVersion: string | null;
  version: string | null;
};

// Insert shape mirrors what parsers produce (flat row with metadata). The
// storage layer splits metadata into the `bouncers` upsert internally.
export type NewBouncerMetric = InsertBouncerMetric & {
  bouncerType?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  version?: string | null;
};

export interface BouncerMetricsQuery {
  lapiServerName?: string;
  bouncerName?: string;
  /** Lower bound on collectedAt (unix ms, inclusive). */
  since?: number;
  /** Upper bound on collectedAt (unix ms, inclusive). */
  until?: number;
  limit?: number;
}

export interface BouncerNameRow {
  lapiServerName: string;
  bouncerName: string;
  bouncerType: string | null;
}

export interface StoreAlertsOptions {
  geoipLookup?: (ip: string) => GeoIPInfo | null;
  replicationEnabled?: boolean;
}

export interface StoreAlertsResult {
  /** Indices of alerts that have replicable decisions (for marking as replicated after success) */
  replicableIndices: number[];
}

export interface RecordUnbanEventInput {
  ip: string;
  scope: 'ip' | 'range';
  comment: string;
  server: string;
  decisionId: number;
  /**
   * Identifier of the human user who triggered the unban (e.g. email/name/sub
   * sourced from the dashboard OIDC session). Stored in the `actor` column for
   * audit trails. Truncated by the caller to <= 256 chars; null/undefined when
   * the request was unauthenticated.
   */
  actor?: string | null;
  geoipLookup?: (ip: string) => GeoIPInfo | null;
}

/**
 * Input for {@link AlertStorage.recordManualBanAuditEvent}, the local-audit
 * row that pairs with a manual ban issued via POST /api/decisions/ban.
 *
 * The audit row is inserted immediately after the LAPI ban call succeeds so
 * the timeline reflects the human action without waiting for the
 * LAPI -> signals roundtrip. It is not forwarded to CAPI and is excluded
 * from alert/decision statistics. Duplicate rows alongside the round-tripped
 * `crowdsieve/manual` alert are accepted intentionally.
 */
export interface RecordManualBanAuditEventInput {
  ip: string;
  scope: 'ip' | 'range';
  comment: string;
  server: string;
  /** Duration of the original ban (e.g. "4h"). Recorded in `raw_json`. */
  duration: string;
  /**
   * LAPI-returned decision id, when the LAPI response carried one. Recorded
   * in `raw_json` for forensic linking; omitted otherwise.
   */
  decisionId?: number;
  /** See {@link RecordUnbanEventInput.actor}. */
  actor?: string | null;
  geoipLookup?: (ip: string) => GeoIPInfo | null;
}

export interface AlertStorage {
  storeAlerts(
    alerts: Alert[],
    filterDetails: FilterEngineResult['filterDetails'],
    options?: StoreAlertsOptions
  ): Promise<StoreAlertsResult>;
  markAlertsForwarded(indices: number[]): Promise<void>;
  markAlertsReplicated(indices: number[]): Promise<void>;
  recordUnbanEvent(input: RecordUnbanEventInput): Promise<number>;
  recordManualBanAuditEvent(input: RecordManualBanAuditEventInput): Promise<number>;
  queryAlerts(query: AlertQuery): Promise<SelectAlert[]>;
  getAlertById(id: number): Promise<SelectAlert | null>;
  hasAlertsNewerThan(timestamp: Date): Promise<boolean>;
  getStats(since?: Date): Promise<AlertStats>;
  getTimeDistributionStats(since?: Date): Promise<TimeDistributionStats>;
  getDecisionStats(since?: Date): Promise<DecisionStats>;
  cleanup(retentionDays: number): Promise<number>;
  saveBouncerMetrics(rows: NewBouncerMetric[]): Promise<void>;
  getBouncerMetrics(filters: BouncerMetricsQuery): Promise<BouncerMetric[]>;
  getBouncerNames(): Promise<BouncerNameRow[]>;
  cleanupBouncerMetrics(retentionDays: number): Promise<number>;
}

// Import shared replication constants
import { REPLICATION_ORIGIN } from '../replication/index.js';

/**
 * Check if an alert has decisions from crowdsieve-replication origin
 * These alerts should not be stored (they are duplicates)
 */
function isReplicatedAlert(alert: Alert): boolean {
  if (!alert.decisions || alert.decisions.length === 0) {
    return false;
  }
  const replicationOrigin = REPLICATION_ORIGIN.toLowerCase();
  return alert.decisions.some((decision) => {
    const origin = decision.origin?.toLowerCase() || '';
    return origin.includes(replicationOrigin);
  });
}

/**
 * Check if an alert has decisions that will be replicated
 * (non-crowdsieve origin decisions)
 */
function hasReplicableDecisions(alert: Alert): boolean {
  if (!alert.decisions || alert.decisions.length === 0) {
    return false;
  }
  const excludedOrigins = ['crowdsieve', 'crowdsieve-replication'];
  return alert.decisions.some((decision) => {
    const origin = decision.origin?.toLowerCase() || '';
    return !excludedOrigins.some((excluded) => origin.includes(excluded.toLowerCase()));
  });
}

/**
 * Internal shape used by {@link recordLocalAuditEvent} to encode either an
 * unban audit row (`crowdsieve/unban`) or a manual-ban audit row
 * (`crowdsieve/manual-audit`). Both share the same insert template; only
 * the scenario string and the optional `duration` differ.
 */
interface RecordLocalAuditEventInput {
  scenario: typeof UNBAN_AUDIT_SCENARIO | typeof MANUAL_BAN_AUDIT_SCENARIO;
  ip: string;
  scope: 'ip' | 'range';
  comment: string;
  server: string;
  /** Defined for unban audits; possibly defined for manual-ban audits. */
  decisionId?: number;
  /** Defined for manual-ban audits only. */
  duration?: string;
  actor?: string | null;
  geoipLookup?: (ip: string) => GeoIPInfo | null;
}

/**
 * Insert a local-audit row in the alerts table. Shared implementation behind
 * `recordUnbanEvent` (kept for back-compat) and `recordManualBanAuditEvent`.
 *
 * Audit rows are pre-flagged with `filtered=true`, `forwardedToCapi=false`,
 * `localAudit=true`, `replicated=false`, `hasDecisions=false` so they are
 * excluded from stats and the (defunct) signal-forwarding path. The
 * distinguishing `scenario` is the only field that varies between the two
 * audit kinds; the JSON payload in `raw_json` carries the `kind`, server,
 * decision id (if any), duration (manual-ban only), comment, ip, scope and
 * actor for downstream consumers.
 */
async function recordLocalAuditEvent(input: RecordLocalAuditEventInput): Promise<number> {
  const { db, schema, isPostgres } = getDatabaseContext();
  const { scenario, ip, scope, comment, server, decisionId, duration, geoipLookup } = input;
  // Normalize actor: trim, truncate to MAX_ACTOR_LENGTH, and treat empty
  // / whitespace-only strings as NULL so audit logs never carry padding or
  // oversized values from upstream callers.
  const actor = sanitizeActor(input.actor);

  // GeoIP enrichment when IP is valid (mirror storeAlerts behavior)
  const ipToLookup = extractIpFromValue(ip);
  const geoip = net.isIP(ipToLookup) ? geoipLookup?.(ipToLookup) || null : null;

  const kind = scenario === UNBAN_AUDIT_SCENARIO ? 'unban' : 'manual-ban';

  const insertQuery = db
    .insert(schema.alerts)
    .values({
      scenario,
      scenarioVersion: CROWDSIEVE_VERSION,
      message: comment,
      simulated: false,
      remediation: false,
      hasDecisions: false,
      replicated: false,
      sourceScope: scope,
      sourceValue: ip,
      sourceIp: scope === 'ip' ? ip : undefined,
      sourceRange: scope === 'range' ? ip : undefined,
      geoCountryCode: geoip?.countryCode,
      geoCountryName: geoip?.countryName,
      geoCity: geoip?.city,
      geoRegion: geoip?.region,
      geoLatitude: geoip?.latitude,
      geoLongitude: geoip?.longitude,
      geoTimezone: geoip?.timezone,
      geoIsp: geoip?.isp,
      geoOrg: geoip?.org,
      // Defensive: mark as filtered so any future signal-forwarding logic that
      // operates on un-filtered alerts will skip these. recordLocalAuditEvent
      // does not go through the signals path, but this prevents accidental
      // forwarding.
      filtered: true,
      forwardedToCapi: false,
      localAudit: true,
      actor,
      rawJson: JSON.stringify({
        kind,
        server,
        decisionId: decisionId ?? null,
        duration: duration ?? null,
        comment,
        ip,
        scope,
        actor,
      }),
    } as typeof schema.alerts.$inferInsert)
    .returning({ id: schema.alerts.id });

  let result: { id: number } | undefined;
  if (isPostgres) {
    const rows = await insertQuery;
    result = rows[0];
  } else {
    result = (insertQuery as unknown as { get(): { id: number } | undefined }).get();
  }

  if (!result) {
    throw new Error(`Failed to record local audit event (${kind})`);
  }

  return result.id;
}

export function createStorage(): AlertStorage {
  // Map from original alert index to inserted database ID
  let lastInsertedIdMap: Map<number, number> = new Map();

  return {
    async storeAlerts(alerts, filterDetails, options): Promise<StoreAlertsResult> {
      const { db, schema, isPostgres } = getDatabaseContext();
      const geoipLookup = options?.geoipLookup;
      lastInsertedIdMap = new Map();
      const replicableIndices: number[] = [];

      for (let i = 0; i < alerts.length; i++) {
        const alert = alerts[i];
        const detail = filterDetails[i];

        // Skip alerts with crowdsieve-replication origin (duplicates from LAPI)
        if (isReplicatedAlert(alert)) {
          continue;
        }

        // Skip duplicate alerts based on UUID (prevents re-storing the same alert)
        if (alert.uuid) {
          const existingQuery = db
            .select({ id: schema.alerts.id })
            .from(schema.alerts)
            .where(eq(schema.alerts.uuid, alert.uuid))
            .limit(1);

          const exists = isPostgres
            ? (await existingQuery).length > 0
            : (existingQuery as unknown as { get(): { id: number } | undefined }).get() !==
              undefined;

          if (exists) {
            continue;
          }
        }

        // Validate IP before GeoIP lookup to avoid silent failures
        const rawIpValue = alert.source.ip || alert.source.value || '';
        const ipToLookup = extractIpFromValue(rawIpValue);
        const geoip = net.isIP(ipToLookup) ? geoipLookup?.(ipToLookup) || null : null;

        // Extract actor from event meta if propagated by the dashboard ban path.
        // The /api/decisions/ban handler injects { key: 'actor', value: <login> }
        // into the alert payload's events[].meta so the human identity survives
        // the LAPI -> signals roundtrip and lands in the alerts table.
        let actorFromMeta: string | null = null;
        if (alert.events && alert.events.length > 0) {
          for (const ev of alert.events) {
            if (ev.meta && Array.isArray(ev.meta)) {
              const found = ev.meta.find((m) => m && m.key === 'actor');
              if (found?.value !== undefined && found.value !== null) {
                const sanitized = sanitizeActor(String(found.value));
                if (sanitized) {
                  actorFromMeta = sanitized;
                  break;
                }
              }
            }
          }
        }

        // Track alerts with replicable decisions (to be marked as replicated after successful replication)
        const hasReplicable = hasReplicableDecisions(alert);
        if (hasReplicable) {
          replicableIndices.push(i);
        }

        // Insert alert with error handling for unique constraint violations (race conditions)
        let result: { id: number } | undefined;
        try {
          const insertQuery = db
            .insert(schema.alerts)
            .values({
              uuid: alert.uuid,
              machineId: alert.machine_id,
              scenario: alert.scenario,
              scenarioHash: alert.scenario_hash,
              scenarioVersion: alert.scenario_version,
              message: alert.message,
              eventsCount: alert.events_count,
              capacity: alert.capacity,
              leakspeed: alert.leakspeed,
              startAt: alert.start_at,
              stopAt: alert.stop_at,
              createdAt: alert.created_at,
              simulated: alert.simulated,
              remediation: alert.remediation,
              hasDecisions: (alert.decisions?.length || 0) > 0,
              replicated: false, // Will be set to true after successful replication
              sourceScope: alert.source.scope,
              sourceValue: alert.source.value,
              sourceIp: alert.source.ip,
              sourceRange: alert.source.range,
              sourceAsNumber: alert.source.as_number,
              sourceAsName: alert.source.as_name,
              sourceCn: alert.source.cn,
              geoCountryCode: geoip?.countryCode || alert.source.cn,
              geoCountryName: geoip?.countryName,
              geoCity: geoip?.city,
              geoRegion: geoip?.region,
              geoLatitude: geoip?.latitude || alert.source.latitude,
              geoLongitude: geoip?.longitude || alert.source.longitude,
              geoTimezone: geoip?.timezone,
              geoIsp: geoip?.isp,
              geoOrg: geoip?.org,
              filtered: detail.filtered,
              filterReasons:
                detail.matchedFilters.length > 0
                  ? JSON.stringify(detail.matchedFilters.map((f) => f.reason).filter(Boolean))
                  : null,
              actor: actorFromMeta,
              rawJson: JSON.stringify(alert),
            } as typeof schema.alerts.$inferInsert)
            .returning({ id: schema.alerts.id });

          // Handle SQLite vs PostgreSQL result format
          if (isPostgres) {
            const rows = await insertQuery;
            result = rows[0];
          } else {
            result = (insertQuery as unknown as { get(): { id: number } | undefined }).get();
          }
        } catch (err) {
          // Handle unique constraint violation (race condition on uuid)
          // SQLite: SQLITE_CONSTRAINT_UNIQUE (code contains 'UNIQUE')
          // PostgreSQL: error code '23505' (unique_violation)
          const error = err as { code?: string; message?: string };
          if (
            error.code === '23505' ||
            (error.message && error.message.includes('UNIQUE constraint failed'))
          ) {
            // Duplicate alert, skip
            continue;
          }
          throw err;
        }

        if (result) {
          lastInsertedIdMap.set(i, result.id);

          // Store decisions
          if (alert.decisions && alert.decisions.length > 0) {
            for (const decision of alert.decisions) {
              const decisionInsert = db.insert(schema.decisions).values({
                alertId: result.id,
                uuid: decision.uuid,
                origin: decision.origin,
                type: decision.type,
                scope: decision.scope,
                value: decision.value,
                duration: decision.duration,
                scenario: decision.scenario,
                simulated: decision.simulated,
                until: decision.until,
              } as typeof schema.decisions.$inferInsert);

              if (isPostgres) {
                await decisionInsert;
              } else {
                (decisionInsert as unknown as { run(): void }).run();
              }
            }
          }
        }
      }

      return { replicableIndices };
    },

    async markAlertsForwarded(indices) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const now = new Date().toISOString();

      for (const index of indices) {
        const id = lastInsertedIdMap.get(index);
        if (id !== undefined) {
          const updateQuery = db
            .update(schema.alerts)
            .set({ forwardedToCapi: true, forwardedAt: now })
            .where(eq(schema.alerts.id, id));

          if (isPostgres) {
            await updateQuery;
          } else {
            (updateQuery as unknown as { run(): void }).run();
          }
        }
      }
    },

    async markAlertsReplicated(indices) {
      const { db, schema, isPostgres } = getDatabaseContext();

      for (const index of indices) {
        const id = lastInsertedIdMap.get(index);
        if (id !== undefined) {
          const updateQuery = db
            .update(schema.alerts)
            .set({ replicated: true })
            .where(eq(schema.alerts.id, id));

          if (isPostgres) {
            await updateQuery;
          } else {
            (updateQuery as unknown as { run(): void }).run();
          }
        }
      }
    },

    async recordUnbanEvent(input): Promise<number> {
      // Thin wrapper over the shared local-audit insert. Kept on the public
      // AlertStorage API for back-compat with PR #29 callers.
      return recordLocalAuditEvent({
        scenario: UNBAN_AUDIT_SCENARIO,
        ip: input.ip,
        scope: input.scope,
        comment: input.comment,
        server: input.server,
        decisionId: input.decisionId,
        actor: input.actor,
        geoipLookup: input.geoipLookup,
      });
    },

    async recordManualBanAuditEvent(input): Promise<number> {
      // Local-audit row mirroring a manual ban (POST /api/decisions/ban).
      // Inserted immediately after the LAPI ban succeeds so the dashboard
      // timeline shows who took the action without waiting for the
      // LAPI -> signals roundtrip. The duplicate row alongside the
      // round-tripped `crowdsieve/manual` alert is intentional; the audit
      // row is filtered out of stats and never forwarded to CAPI.
      return recordLocalAuditEvent({
        scenario: MANUAL_BAN_AUDIT_SCENARIO,
        ip: input.ip,
        scope: input.scope,
        comment: input.comment,
        server: input.server,
        decisionId: input.decisionId,
        duration: input.duration,
        actor: input.actor,
        geoipLookup: input.geoipLookup,
      });
    },

    async queryAlerts(query) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const conditions = [];

      if (query.filtered !== undefined) {
        conditions.push(eq(schema.alerts.filtered, query.filtered));
      }
      if (query.forwardedToCapi !== undefined) {
        conditions.push(eq(schema.alerts.forwardedToCapi, query.forwardedToCapi));
      }
      if (query.scenario) {
        const escaped = escapeLikePattern(query.scenario);
        conditions.push(like(schema.alerts.scenario, `%${escaped}%`));
      }
      if (query.sourceCountry) {
        conditions.push(eq(schema.alerts.geoCountryCode, query.sourceCountry));
      }
      if (query.sourceIp) {
        // Search in both sourceIp and sourceValue (IP can be in either field)
        conditions.push(
          or(
            eq(schema.alerts.sourceIp, query.sourceIp),
            eq(schema.alerts.sourceValue, query.sourceIp)
          )
        );
      }
      if (query.machineId) {
        conditions.push(eq(schema.alerts.machineId, query.machineId));
      }
      if (query.since) {
        conditions.push(gte(schema.alerts.receivedAt, query.since.toISOString()));
      }
      if (query.until) {
        conditions.push(lte(schema.alerts.receivedAt, query.until.toISOString()));
      }

      const baseQuery = db.select().from(schema.alerts);
      const withConditions =
        conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

      const finalQuery = withConditions
        .orderBy(desc(schema.alerts.receivedAt))
        .limit(query.limit || 100)
        .offset(query.offset || 0);

      if (isPostgres) {
        return (await finalQuery) as SelectAlert[];
      } else {
        return (finalQuery as unknown as { all(): SelectAlert[] }).all();
      }
    },

    async getAlertById(id) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const query = db.select().from(schema.alerts).where(eq(schema.alerts.id, id));

      if (isPostgres) {
        const rows = await query;
        return (rows[0] as SelectAlert) || null;
      } else {
        const result = (query as unknown as { get(): SelectAlert | undefined }).get();
        return result || null;
      }
    },

    async hasAlertsNewerThan(timestamp) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const query = db
        .select({ count: sql<number>`1` })
        .from(schema.alerts)
        .where(gt(schema.alerts.receivedAt, timestamp.toISOString()))
        .limit(1);

      if (isPostgres) {
        const rows = await query;
        return rows.length > 0;
      } else {
        const result = (query as unknown as { get(): { count: number } | undefined }).get();
        return result !== undefined;
      }
    },

    async getStats(since) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const sinceDate = since?.toISOString();
      const sinceCondition = sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined;
      // Exclude locally-recorded audit events (unban + manual-ban audit) from
      // all alert/decision statistics so the dashboard's stats reflect real
      // CrowdSec activity, not the audit rows we insert ourselves.
      const notLocalAudit = sql`(${schema.alerts.localAudit} IS NULL OR ${schema.alerts.localAudit} = ${isPostgres ? sql`FALSE` : sql`0`})`;

      // Use Drizzle's sql template with schema column references
      // This lets Drizzle handle the boolean representation for each database
      const filteredCondition = sql<number>`sum(case when ${schema.alerts.filtered} then 1 else 0 end)`;
      const forwardedCondition = sql<number>`sum(case when ${schema.alerts.forwardedToCapi} then 1 else 0 end)`;

      // Total counts and time bounds
      const totalQuery = db
        .select({
          total: sql<number>`count(*)`,
          filtered: filteredCondition,
          forwarded: forwardedCondition,
          minTime: sql<string | null>`min(${schema.alerts.receivedAt})`,
          maxTime: sql<string | null>`max(${schema.alerts.receivedAt})`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit));

      let totalResult:
        | {
            total: number;
            filtered: number;
            forwarded: number;
            minTime: string | null;
            maxTime: string | null;
          }
        | undefined;

      if (isPostgres) {
        const rows = await totalQuery;
        totalResult = rows[0];
      } else {
        totalResult = (
          totalQuery as unknown as {
            get(): typeof totalResult;
          }
        ).get();
      }

      // Top scenarios
      const scenariosQuery = db
        .select({
          scenario: schema.alerts.scenario,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(schema.alerts.scenario)
        .orderBy(sql`count desc`)
        .limit(10);

      let topScenarios: Array<{ scenario: string; count: number }>;
      if (isPostgres) {
        topScenarios = await scenariosQuery;
      } else {
        topScenarios = (
          scenariosQuery as unknown as { all(): Array<{ scenario: string; count: number }> }
        ).all();
      }

      // All distinct scenarios — populates the scenario filter dropdown.
      // Unlike `topScenarios`, this includes locally-recorded audit rows so
      // the user can filter on `crowdsieve/unban`, `crowdsieve/manual-audit`,
      // `crowdsieve/manual`, etc. Capped at 500 to keep the `/api/stats`
      // payload and aggregation cost bounded — far above any realistic
      // CrowdSec scenario cardinality.
      const allScenariosQuery = db
        .select({
          scenario: schema.alerts.scenario,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(sinceCondition)
        .groupBy(schema.alerts.scenario)
        .orderBy(sql`count desc`)
        .limit(500);

      let allScenarios: Array<{ scenario: string; count: number }>;
      if (isPostgres) {
        allScenarios = await allScenariosQuery;
      } else {
        allScenarios = (
          allScenariosQuery as unknown as { all(): Array<{ scenario: string; count: number }> }
        ).all();
      }

      // Top countries
      const countriesQuery = db
        .select({
          country: schema.alerts.geoCountryCode,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit, sql`geo_country_code is not null`))
        .groupBy(schema.alerts.geoCountryCode)
        .orderBy(sql`count desc`)
        .limit(10);

      let topCountries: Array<{ country: string | null; count: number }>;
      if (isPostgres) {
        topCountries = await countriesQuery;
      } else {
        topCountries = (
          countriesQuery as unknown as { all(): Array<{ country: string | null; count: number }> }
        ).all();
      }

      // Blocked requests: straight sum of `dropped_items` across every
      // remediation snapshot in the retention window. CrowdSec's
      // `usage-metrics` payload reports `dropped`/`processed`/`bytes` as
      // **per-window counters** (one block per `WindowSizeSeconds`, value
      // scoped to that window only) — the parser already sums across blocks
      // before persisting, so each row holds a per-window total. Aggregating
      // them is therefore a plain SUM; no delta-with-reset windowing.
      //
      // The `metrics_json != '[]'` guard skips pre-existing phantom rows
      // produced by older parser code that emitted an empty-items snapshot
      // for freshly-registered bouncers.
      //
      // NOTE: the retention window is hardcoded to 30 days here; it will be
      // wired to config.bouncer_metrics.retention_days when storage gains
      // config access.
      const blockedRequestsCutoffMs = Date.now() - 30 * 86400 * 1000;
      const blockedRequestsQuery = sql<{ total: number }>`
        SELECT COALESCE(SUM(dropped_items), 0) AS total
        FROM bouncer_metrics
        WHERE component_kind = 'remediation'
          AND collected_at >= ${blockedRequestsCutoffMs}
          AND metrics_json != '[]'
      `;

      let blockedRequests = 0;
      try {
        if (isPostgres) {
          // drizzle-orm/node-postgres resolves db.execute() to a pg QueryResult
          // ({ rows: [...] }), NOT a bare array — reading [0] off the result
          // object yields undefined and silently pins blockedRequests to 0.
          // Stay agnostic in case a future driver returns the array directly.
          const res = await db.execute(blockedRequestsQuery);
          const rows = (
            Array.isArray(res) ? res : ((res as { rows?: Array<{ total: number }> })?.rows ?? [])
          ) as Array<{ total: number }>;
          blockedRequests = Number(rows[0]?.total) || 0;
        } else {
          const rows = (db as unknown as { all<T>(q: unknown): T[] }).all<{ total: number }>(
            blockedRequestsQuery
          );
          blockedRequests = Number(rows[0]?.total) || 0;
        }
      } catch {
        // bouncerMetrics table may not exist yet (pre-migration envs); fall back to 0
      }

      // PostgreSQL returns bigint as string, ensure we return numbers
      return {
        total: Number(totalResult?.total) || 0,
        filtered: Number(totalResult?.filtered) || 0,
        forwarded: Number(totalResult?.forwarded) || 0,
        blockedRequests,
        topScenarios: topScenarios.map((s) => ({
          scenario: s.scenario,
          count: Number(s.count),
        })),
        allScenarios: allScenarios.map((s) => ({
          scenario: s.scenario,
          count: Number(s.count),
        })),
        topCountries: topCountries.map((c) => ({
          country: c.country || 'Unknown',
          count: Number(c.count),
        })),
        timeBounds: {
          min: totalResult?.minTime || null,
          max: totalResult?.maxTime || null,
        },
      };
    },

    async getTimeDistributionStats(since) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const sinceDate = since?.toISOString();
      const sinceCondition = sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined;
      // Exclude locally-recorded audit events from time-distribution stats.
      const notLocalAudit = sql`(${schema.alerts.localAudit} IS NULL OR ${schema.alerts.localAudit} = ${isPostgres ? sql`FALSE` : sql`0`})`;

      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      // Day of week extraction: SQLite strftime('%w') and PostgreSQL EXTRACT(DOW) both return 0-6 (Sunday=0)
      const dayOfWeekExpr = isPostgres
        ? sql<number>`EXTRACT(DOW FROM ${schema.alerts.receivedAt}::timestamp)`
        : sql<number>`CAST(strftime('%w', ${schema.alerts.receivedAt}) AS INTEGER)`;

      // Hour extraction
      const hourOfDayExpr = isPostgres
        ? sql<number>`EXTRACT(HOUR FROM ${schema.alerts.receivedAt}::timestamp)`
        : sql<number>`CAST(strftime('%H', ${schema.alerts.receivedAt}) AS INTEGER)`;

      // Date extraction for daily trend
      const dateExpr = isPostgres
        ? sql<string>`DATE(${schema.alerts.receivedAt}::timestamp)`
        : sql<string>`date(${schema.alerts.receivedAt})`;

      // Query: Alerts by day of week
      const dayOfWeekQuery = db
        .select({
          day: dayOfWeekExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(dayOfWeekExpr)
        .orderBy(dayOfWeekExpr);

      // Query: Alerts by hour of day
      const hourOfDayQuery = db
        .select({
          hour: hourOfDayExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(hourOfDayExpr)
        .orderBy(hourOfDayExpr);

      // Query: Alerts by country (with country name)
      const byCountryQuery = db
        .select({
          countryCode: schema.alerts.geoCountryCode,
          countryName: schema.alerts.geoCountryName,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit, sql`${schema.alerts.geoCountryCode} is not null`))
        .groupBy(schema.alerts.geoCountryCode, schema.alerts.geoCountryName)
        .orderBy(sql`count desc`)
        .limit(15);

      // Query: Alerts by scenario (top 10)
      const byScenarioQuery = db
        .select({
          scenario: schema.alerts.scenario,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(schema.alerts.scenario)
        .orderBy(sql`count desc`)
        .limit(10);

      // Query: Daily trend
      const dailyTrendQuery = db
        .select({
          date: dateExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(dateExpr)
        .orderBy(dateExpr);

      // Query: Total count and date range
      const summaryQuery = db
        .select({
          total: sql<number>`count(*)`,
          minDate: sql<string | null>`min(${schema.alerts.receivedAt})`,
          maxDate: sql<string | null>`max(${schema.alerts.receivedAt})`,
        })
        .from(schema.alerts)
        .where(and(sinceCondition, notLocalAudit));

      // Execute queries
      let byDayOfWeek: Array<{ day: number; count: number }>;
      let byHourOfDay: Array<{ hour: number; count: number }>;
      let byCountry: Array<{
        countryCode: string | null;
        countryName: string | null;
        count: number;
      }>;
      let byScenario: Array<{ scenario: string; count: number }>;
      let dailyTrend: Array<{ date: string; count: number }>;
      let summary: { total: number; minDate: string | null; maxDate: string | null } | undefined;

      if (isPostgres) {
        [byDayOfWeek, byHourOfDay, byCountry, byScenario, dailyTrend, summary] = await Promise.all([
          dayOfWeekQuery as Promise<Array<{ day: number; count: number }>>,
          hourOfDayQuery as Promise<Array<{ hour: number; count: number }>>,
          byCountryQuery as Promise<
            Array<{
              countryCode: string | null;
              countryName: string | null;
              count: number;
            }>
          >,
          byScenarioQuery as Promise<Array<{ scenario: string; count: number }>>,
          dailyTrendQuery as Promise<Array<{ date: string; count: number }>>,
          summaryQuery.then(
            (rows: Array<{ total: number; minDate: string | null; maxDate: string | null }>) =>
              rows[0]
          ),
        ]);
      } else {
        byDayOfWeek = (
          dayOfWeekQuery as unknown as {
            all(): Array<{ day: number; count: number }>;
          }
        ).all();
        byHourOfDay = (
          hourOfDayQuery as unknown as {
            all(): Array<{ hour: number; count: number }>;
          }
        ).all();
        byCountry = (
          byCountryQuery as unknown as {
            all(): Array<{
              countryCode: string | null;
              countryName: string | null;
              count: number;
            }>;
          }
        ).all();
        byScenario = (
          byScenarioQuery as unknown as {
            all(): Array<{ scenario: string; count: number }>;
          }
        ).all();
        dailyTrend = (
          dailyTrendQuery as unknown as {
            all(): Array<{ date: string; count: number }>;
          }
        ).all();
        summary = (
          summaryQuery as unknown as {
            get(): typeof summary;
          }
        ).get();
      }

      return {
        byDayOfWeek: byDayOfWeek.map((d) => ({
          day: Number(d.day),
          dayName: DAY_NAMES[Number(d.day)] || 'Unknown',
          count: Number(d.count),
        })),
        byHourOfDay: byHourOfDay.map((h) => ({
          hour: Number(h.hour),
          count: Number(h.count),
        })),
        byCountry: byCountry.map((c) => {
          const countryCode = c.countryCode || 'Unknown';
          const countryName = countryCode === 'Unknown' ? 'Unknown' : c.countryName || countryCode;
          return {
            countryCode,
            countryName,
            count: Number(c.count),
          };
        }),
        byScenario: byScenario.map((s) => ({
          scenario: s.scenario,
          count: Number(s.count),
        })),
        dailyTrend: dailyTrend.map((d) => ({
          date: d.date,
          count: Number(d.count),
        })),
        totalAlerts: Number(summary?.total) || 0,
        dateRange: {
          from: summary?.minDate || null,
          to: summary?.maxDate || null,
        },
      };
    },

    async getDecisionStats(since) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const sinceDate = since?.toISOString();

      // Join decisions with alerts to filter by date
      // We need to filter decisions based on their associated alert's receivedAt
      const sinceCondition = sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined;
      // Exclude locally-recorded audit events from decision statistics.
      const notLocalAudit = sql`(${schema.alerts.localAudit} IS NULL OR ${schema.alerts.localAudit} = ${isPostgres ? sql`FALSE` : sql`0`})`;

      // Query: Total decisions count
      const totalQuery = db
        .select({
          total: sql<number>`count(*)`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit));

      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      // Day of week extraction for decisions (based on alert receivedAt)
      const dayOfWeekExpr = isPostgres
        ? sql<number>`EXTRACT(DOW FROM ${schema.alerts.receivedAt}::timestamp)`
        : sql<number>`CAST(strftime('%w', ${schema.alerts.receivedAt}) AS INTEGER)`;

      // Hour extraction for decisions
      const hourOfDayExpr = isPostgres
        ? sql<number>`EXTRACT(HOUR FROM ${schema.alerts.receivedAt}::timestamp)`
        : sql<number>`CAST(strftime('%H', ${schema.alerts.receivedAt}) AS INTEGER)`;

      // Query: Decisions by day of week
      const byDayOfWeekQuery = db
        .select({
          day: dayOfWeekExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(dayOfWeekExpr)
        .orderBy(dayOfWeekExpr);

      // Query: Decisions by hour of day
      const byHourOfDayQuery = db
        .select({
          hour: hourOfDayExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit))
        .groupBy(hourOfDayExpr)
        .orderBy(hourOfDayExpr);

      // Query: Decisions by duration category
      // Categories: <1h, 1-24h, 1-7d, >7d
      // Duration is stored as string like "4h", "24h", "168h"
      const durationCategoryExpr = isPostgres
        ? sql<string>`CASE
            WHEN ${schema.decisions.duration} ~ '^[0-9]+s$' THEN '<1h'
            WHEN ${schema.decisions.duration} ~ '^[0-9]+m$' THEN '<1h'
            WHEN ${schema.decisions.duration} ~ '^[0-9]+h$' AND CAST(REGEXP_REPLACE(${schema.decisions.duration}, '[^0-9]', '', 'g') AS INTEGER) < 24 THEN '1-24h'
            WHEN ${schema.decisions.duration} ~ '^[0-9]+h$' AND CAST(REGEXP_REPLACE(${schema.decisions.duration}, '[^0-9]', '', 'g') AS INTEGER) < 168 THEN '1-7d'
            ELSE '>7d'
          END`
        : sql<string>`CASE
            WHEN ${schema.decisions.duration} LIKE '%s' THEN '<1h'
            WHEN ${schema.decisions.duration} LIKE '%m' THEN '<1h'
            WHEN ${schema.decisions.duration} LIKE '%h' AND CAST(REPLACE(${schema.decisions.duration}, 'h', '') AS INTEGER) < 24 THEN '1-24h'
            WHEN ${schema.decisions.duration} LIKE '%h' AND CAST(REPLACE(${schema.decisions.duration}, 'h', '') AS INTEGER) < 168 THEN '1-7d'
            ELSE '>7d'
          END`;

      // Filter out null durations to avoid incorrect categorization
      const byDurationQuery = db
        .select({
          category: durationCategoryExpr,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit, sql`${schema.decisions.duration} is not null`))
        .groupBy(durationCategoryExpr)
        .orderBy(sql`count desc`);

      // Query: Top scenarios for decisions (keep full scenario path as-is)
      // Scenario already contains the full path like "crowdsecurity/http-bad-user-agent"
      const topScenariosQuery = db
        .select({
          scenario: schema.decisions.scenario,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit, sql`${schema.decisions.scenario} is not null`))
        .groupBy(schema.decisions.scenario)
        .orderBy(sql`count desc`)
        .limit(10);

      // Query: Decisions by country (from associated alerts)
      // Filter out null country codes to avoid grouping decisions without geo data
      const byCountryQuery = db
        .select({
          countryCode: schema.alerts.geoCountryCode,
          countryName: schema.alerts.geoCountryName,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.decisions)
        .innerJoin(schema.alerts, eq(schema.decisions.alertId, schema.alerts.id))
        .where(and(sinceCondition, notLocalAudit, sql`${schema.alerts.geoCountryCode} is not null`))
        .groupBy(schema.alerts.geoCountryCode, schema.alerts.geoCountryName)
        .orderBy(sql`count desc`)
        .limit(15);

      // Execute queries
      let total: { total: number } | undefined;
      let byDayOfWeek: Array<{ day: number; count: number }>;
      let byHourOfDay: Array<{ hour: number; count: number }>;
      let byDuration: Array<{ category: string; count: number }>;
      let topScenarios: Array<{ scenario: string | null; count: number }>;
      let byCountry: Array<{
        countryCode: string | null;
        countryName: string | null;
        count: number;
      }>;

      if (isPostgres) {
        [total, byDayOfWeek, byHourOfDay, byDuration, topScenarios, byCountry] = await Promise.all([
          totalQuery.then((rows: Array<{ total: number }>) => rows[0]),
          byDayOfWeekQuery as Promise<Array<{ day: number; count: number }>>,
          byHourOfDayQuery as Promise<Array<{ hour: number; count: number }>>,
          byDurationQuery as Promise<Array<{ category: string; count: number }>>,
          topScenariosQuery as Promise<Array<{ scenario: string | null; count: number }>>,
          byCountryQuery as Promise<
            Array<{ countryCode: string | null; countryName: string | null; count: number }>
          >,
        ]);
      } else {
        total = (totalQuery as unknown as { get(): { total: number } | undefined }).get();
        byDayOfWeek = (
          byDayOfWeekQuery as unknown as { all(): Array<{ day: number; count: number }> }
        ).all();
        byHourOfDay = (
          byHourOfDayQuery as unknown as { all(): Array<{ hour: number; count: number }> }
        ).all();
        byDuration = (
          byDurationQuery as unknown as { all(): Array<{ category: string; count: number }> }
        ).all();
        topScenarios = (
          topScenariosQuery as unknown as {
            all(): Array<{ scenario: string | null; count: number }>;
          }
        ).all();
        byCountry = (
          byCountryQuery as unknown as {
            all(): Array<{ countryCode: string | null; countryName: string | null; count: number }>;
          }
        ).all();
      }

      return {
        totalDecisions: Number(total?.total) || 0,
        byDayOfWeek: byDayOfWeek.map((d) => ({
          day: Number(d.day),
          dayName: DAY_NAMES[Number(d.day)] || 'Unknown',
          count: Number(d.count),
        })),
        byHourOfDay: byHourOfDay.map((h) => ({
          hour: Number(h.hour),
          count: Number(h.count),
        })),
        byDurationCategory: byDuration.map((d) => ({
          category: d.category,
          count: Number(d.count),
        })),
        topScenarios: topScenarios
          .filter((s) => s.scenario !== null)
          .map((s) => ({
            scenario: s.scenario!,
            count: Number(s.count),
          })),
        byCountry: byCountry.map((c) => ({
          countryCode: c.countryCode || 'Unknown',
          countryName: c.countryName || c.countryCode || 'Unknown',
          count: Number(c.count),
        })),
      };
    },

    async cleanup(retentionDays) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);

      const deleteQuery = db
        .delete(schema.alerts)
        .where(lte(schema.alerts.receivedAt, cutoff.toISOString()));

      if (isPostgres) {
        const result = await deleteQuery;
        // PostgreSQL returns { rowCount: number }
        return (result as unknown as { rowCount: number }).rowCount || 0;
      } else {
        const result = (deleteQuery as unknown as { run(): { changes: number } }).run();
        return result.changes;
      }
    },

    async saveBouncerMetrics(rows) {
      if (rows.length === 0) return;
      const { db, schema, isPostgres } = getDatabaseContext();

      // Step 1: upsert the `bouncers` registry. We collapse the input to the
      // latest (by collectedAt) row per (lapi, bouncer, kind) so each bouncer
      // is represented once. firstSeenAt uses the minimum collectedAt of the
      // batch — `onConflictDoUpdate` only updates when newer data arrives,
      // and `firstSeenAt` is preserved across conflicts via COALESCE.
      const bouncerByKey = new Map<
        string,
        {
          lapiServerName: string;
          bouncerName: string;
          componentKind: string;
          bouncerType: string | null;
          osName: string | null;
          osVersion: string | null;
          version: string | null;
          firstSeenAt: number;
          lastSeenAt: number;
        }
      >();
      for (const row of rows) {
        const key = `${row.lapiServerName}\x00${row.bouncerName}\x00${row.componentKind}`;
        const existing = bouncerByKey.get(key);
        const collectedAt = row.collectedAt;
        if (!existing) {
          bouncerByKey.set(key, {
            lapiServerName: row.lapiServerName,
            bouncerName: row.bouncerName,
            componentKind: row.componentKind,
            bouncerType: row.bouncerType ?? null,
            osName: row.osName ?? null,
            osVersion: row.osVersion ?? null,
            version: row.version ?? null,
            firstSeenAt: collectedAt,
            lastSeenAt: collectedAt,
          });
        } else {
          if (collectedAt < existing.firstSeenAt) existing.firstSeenAt = collectedAt;
          if (collectedAt >= existing.lastSeenAt) {
            existing.lastSeenAt = collectedAt;
            // Keep metadata from the latest snapshot in the batch.
            existing.bouncerType = row.bouncerType ?? existing.bouncerType;
            existing.osName = row.osName ?? existing.osName;
            existing.osVersion = row.osVersion ?? existing.osVersion;
            existing.version = row.version ?? existing.version;
          }
        }
      }
      const bouncerRows = Array.from(bouncerByKey.values());
      const BOUNCER_CHUNK = 500;
      for (let i = 0; i < bouncerRows.length; i += BOUNCER_CHUNK) {
        const slice = bouncerRows.slice(i, i + BOUNCER_CHUNK);
        const upsert = db
          .insert(schema.bouncers)
          .values(slice)
          .onConflictDoUpdate({
            target: [
              schema.bouncers.lapiServerName,
              schema.bouncers.bouncerName,
              schema.bouncers.componentKind,
            ],
            set: {
              // Preserve the existing firstSeenAt; only widen the lastSeenAt.
              bouncerType: sql`excluded.bouncer_type`,
              osName: sql`excluded.os_name`,
              osVersion: sql`excluded.os_version`,
              version: sql`excluded.version`,
              // Scalar two-arg max differs by dialect: SQLite spells it MAX(a, b),
              // PostgreSQL uses GREATEST(a, b) (its MAX() is aggregate-only).
              lastSeenAt: isPostgres
                ? sql`GREATEST(excluded.last_seen_at, ${schema.bouncers.lastSeenAt})`
                : sql`MAX(excluded.last_seen_at, ${schema.bouncers.lastSeenAt})`,
            },
          });
        if (isPostgres) {
          await upsert;
        } else {
          (upsert as unknown as { run(): void }).run();
        }
      }

      // Step 2: insert the metrics rows themselves (without metadata fields).
      // Same (lapiServerName, bouncerName, componentKind, collectedAt) tuple
      // can be re-relayed by the LAPI when CrowdSec retries POST /v1/usage-metrics.
      // The unique index `bouncer_metrics_unique` enforces this; we ignore
      // conflicts on insert so retries don't double-count per-window counters.
      // Chunk inserts: SQLite caps bind variables at 32766 and Postgres at
      // 65535. With 9 columns per row a 500-row batch stays well below both.
      const METRICS_CHUNK = 500;
      for (let i = 0; i < rows.length; i += METRICS_CHUNK) {
        const slice = rows.slice(i, i + METRICS_CHUNK).map((r) => ({
          lapiServerName: r.lapiServerName,
          componentKind: r.componentKind,
          bouncerName: r.bouncerName,
          activeDecisions: r.activeDecisions ?? null,
          processedItems: r.processedItems ?? null,
          droppedItems: r.droppedItems ?? null,
          bytesProcessed: r.bytesProcessed ?? null,
          collectedAt: r.collectedAt,
          metricsJson: r.metricsJson,
        }));
        const insertQuery = db.insert(schema.bouncerMetrics).values(slice).onConflictDoNothing();
        if (isPostgres) {
          await insertQuery;
        } else {
          (insertQuery as unknown as { run(): void }).run();
        }
      }
    },

    async getBouncerMetrics(filters) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const conditions = [];

      if (filters.lapiServerName) {
        conditions.push(eq(schema.bouncerMetrics.lapiServerName, filters.lapiServerName));
      }
      if (filters.bouncerName) {
        conditions.push(eq(schema.bouncerMetrics.bouncerName, filters.bouncerName));
      }
      if (filters.since !== undefined) {
        conditions.push(gte(schema.bouncerMetrics.collectedAt, filters.since));
      }
      if (filters.until !== undefined) {
        conditions.push(lte(schema.bouncerMetrics.collectedAt, filters.until));
      }

      // Join `bouncers` to flatten metadata back into each row, preserving
      // the public BouncerMetric shape that callers (route handler, dashboard)
      // expect.
      const baseQuery = db
        .select({
          id: schema.bouncerMetrics.id,
          lapiServerName: schema.bouncerMetrics.lapiServerName,
          componentKind: schema.bouncerMetrics.componentKind,
          bouncerName: schema.bouncerMetrics.bouncerName,
          activeDecisions: schema.bouncerMetrics.activeDecisions,
          processedItems: schema.bouncerMetrics.processedItems,
          droppedItems: schema.bouncerMetrics.droppedItems,
          bytesProcessed: schema.bouncerMetrics.bytesProcessed,
          collectedAt: schema.bouncerMetrics.collectedAt,
          metricsJson: schema.bouncerMetrics.metricsJson,
          bouncerType: schema.bouncers.bouncerType,
          osName: schema.bouncers.osName,
          osVersion: schema.bouncers.osVersion,
          version: schema.bouncers.version,
        })
        .from(schema.bouncerMetrics)
        .leftJoin(
          schema.bouncers,
          and(
            eq(schema.bouncerMetrics.lapiServerName, schema.bouncers.lapiServerName),
            eq(schema.bouncerMetrics.bouncerName, schema.bouncers.bouncerName),
            eq(schema.bouncerMetrics.componentKind, schema.bouncers.componentKind)
          )
        );
      const withConditions =
        conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
      const finalQuery = withConditions
        .orderBy(desc(schema.bouncerMetrics.collectedAt))
        .limit(filters.limit ?? 1000);

      if (isPostgres) {
        return (await finalQuery) as BouncerMetric[];
      } else {
        return (finalQuery as unknown as { all(): BouncerMetric[] }).all();
      }
    },

    async getBouncerNames() {
      const { db, schema, isPostgres } = getDatabaseContext();
      // Read from the registry, deduped on (lapiServerName, bouncerName).
      // The registry's PK includes componentKind, so a bouncer that emits
      // both `remediation` and `log_processor` rows (common for hybrid
      // crowdsec agents) appears twice in the table. The dashboard expects
      // one row per bouncer, so we GROUP BY and pick MAX(bouncerType) — a
      // deterministic non-null pick when available.
      const query = db
        .select({
          lapiServerName: schema.bouncers.lapiServerName,
          bouncerName: schema.bouncers.bouncerName,
          bouncerType: sql<string | null>`max(${schema.bouncers.bouncerType})`,
        })
        .from(schema.bouncers)
        .groupBy(schema.bouncers.lapiServerName, schema.bouncers.bouncerName)
        .orderBy(schema.bouncers.lapiServerName, schema.bouncers.bouncerName);

      if (isPostgres) {
        return (await query) as Array<{
          lapiServerName: string;
          bouncerName: string;
          bouncerType: string | null;
        }>;
      } else {
        return (
          query as unknown as {
            all(): Array<{
              lapiServerName: string;
              bouncerName: string;
              bouncerType: string | null;
            }>;
          }
        ).all();
      }
    },

    async cleanupBouncerMetrics(retentionDays) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const deleteQuery = db
        .delete(schema.bouncerMetrics)
        .where(lte(schema.bouncerMetrics.collectedAt, cutoff));

      if (isPostgres) {
        const result = await deleteQuery;
        return (result as unknown as { rowCount: number }).rowCount || 0;
      } else {
        const result = (deleteQuery as unknown as { run(): { changes: number } }).run();
        return result.changes;
      }
    },
  };
}
