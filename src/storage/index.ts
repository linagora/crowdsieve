import { eq, desc, and, or, gte, lte, like, sql } from 'drizzle-orm';
import type { Alert } from '../models/alert.js';
import type { FilterEngineResult } from '../filters/types.js';
import { getDatabaseContext } from '../db/index.js';
import type { GeoIPInfo } from '../models/alert.js';

/**
 * Escape SQL LIKE wildcards to prevent injection
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

export interface AlertQuery {
  filtered?: boolean;
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
  topScenarios: Array<{ scenario: string; count: number }>;
  topCountries: Array<{ country: string; count: number }>;
  timeBounds: { min: string | null; max: string | null };
}

// Import schema types - use SQLite schema types as canonical (they're compatible)
import type { SelectAlert } from '../db/schema.js';

export interface AlertStorage {
  storeAlerts(
    alerts: Alert[],
    filterDetails: FilterEngineResult['filterDetails'],
    geoipLookup?: (ip: string) => GeoIPInfo | null
  ): Promise<void>;
  markAlertsForwarded(indices: number[]): Promise<void>;
  queryAlerts(query: AlertQuery): Promise<SelectAlert[]>;
  getAlertById(id: number): Promise<SelectAlert | null>;
  getStats(since?: Date): Promise<AlertStats>;
  cleanup(retentionDays: number): Promise<number>;
}

export function createStorage(): AlertStorage {
  let lastInsertedIds: number[] = [];

  return {
    async storeAlerts(alerts, filterDetails, geoipLookup) {
      const { db, schema, isPostgres } = getDatabaseContext();
      lastInsertedIds = [];

      for (let i = 0; i < alerts.length; i++) {
        const alert = alerts[i];
        const detail = filterDetails[i];
        const geoip = geoipLookup?.(alert.source.ip || alert.source.value || '') || null;

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
            rawJson: JSON.stringify(alert),
          } as typeof schema.alerts.$inferInsert)
          .returning({ id: schema.alerts.id });

        // Handle SQLite vs PostgreSQL result format
        let result: { id: number } | undefined;
        if (isPostgres) {
          const rows = await insertQuery;
          result = rows[0];
        } else {
          result = (insertQuery as unknown as { get(): { id: number } | undefined }).get();
        }

        if (result) {
          lastInsertedIds.push(result.id);

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
    },

    async markAlertsForwarded(indices) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const now = new Date().toISOString();

      for (const index of indices) {
        const id = lastInsertedIds[index];
        if (id) {
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

    async queryAlerts(query) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const conditions = [];

      if (query.filtered !== undefined) {
        conditions.push(eq(schema.alerts.filtered, query.filtered));
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

    async getStats(since) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const sinceDate = since?.toISOString();
      const sinceCondition = sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined;

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
        .where(sinceCondition);

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
        .where(sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined)
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

      // Top countries
      const countriesQuery = db
        .select({
          country: schema.alerts.geoCountryCode,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(
          and(
            sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined,
            sql`geo_country_code is not null`
          )
        )
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

      // PostgreSQL returns bigint as string, ensure we return numbers
      return {
        total: Number(totalResult?.total) || 0,
        filtered: Number(totalResult?.filtered) || 0,
        forwarded: Number(totalResult?.forwarded) || 0,
        topScenarios: topScenarios.map((s) => ({
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
  };
}
