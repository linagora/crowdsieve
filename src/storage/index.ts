import { eq, desc, and, gte, lte, like, sql } from 'drizzle-orm';
import type { Alert } from '../models/alert.js';
import type { FilterEngineResult } from '../filters/types.js';
import { getDatabase, schema } from '../db/index.js';
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
}

export interface AlertStorage {
  storeAlerts(
    alerts: Alert[],
    filterDetails: FilterEngineResult['filterDetails'],
    geoipLookup?: (ip: string) => GeoIPInfo | null
  ): Promise<void>;
  markAlertsForwarded(indices: number[]): Promise<void>;
  queryAlerts(query: AlertQuery): Promise<schema.SelectAlert[]>;
  getAlertById(id: number): Promise<schema.SelectAlert | null>;
  getStats(since?: Date): Promise<AlertStats>;
  cleanup(retentionDays: number): Promise<number>;
}

export function createStorage(): AlertStorage {
  const db = getDatabase();
  let lastInsertedIds: number[] = [];

  return {
    async storeAlerts(alerts, filterDetails, geoipLookup) {
      lastInsertedIds = [];

      for (let i = 0; i < alerts.length; i++) {
        const alert = alerts[i];
        const detail = filterDetails[i];
        const geoip = geoipLookup?.(alert.source.ip || alert.source.value || '') || null;

        const result = db
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
          })
          .returning({ id: schema.alerts.id })
          .get();

        if (result) {
          lastInsertedIds.push(result.id);

          // Store decisions
          if (alert.decisions && alert.decisions.length > 0) {
            for (const decision of alert.decisions) {
              db.insert(schema.decisions)
                .values({
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
                })
                .run();
            }
          }
        }
      }
    },

    async markAlertsForwarded(indices) {
      const now = new Date().toISOString();
      for (const index of indices) {
        const id = lastInsertedIds[index];
        if (id) {
          db.update(schema.alerts)
            .set({ forwardedToCapi: true, forwardedAt: now })
            .where(eq(schema.alerts.id, id))
            .run();
        }
      }
    },

    async queryAlerts(query) {
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
        conditions.push(eq(schema.alerts.sourceIp, query.sourceIp));
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

      return withConditions
        .orderBy(desc(schema.alerts.receivedAt))
        .limit(query.limit || 100)
        .offset(query.offset || 0)
        .all();
    },

    async getAlertById(id) {
      const result = db.select().from(schema.alerts).where(eq(schema.alerts.id, id)).get();
      return result || null;
    },

    async getStats(since) {
      const sinceDate = since?.toISOString();

      // Total counts
      const totalResult = db
        .select({
          total: sql<number>`count(*)`,
          filtered: sql<number>`sum(case when filtered = 1 then 1 else 0 end)`,
          forwarded: sql<number>`sum(case when forwarded_to_capi = 1 then 1 else 0 end)`,
        })
        .from(schema.alerts)
        .where(sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined)
        .get();

      // Top scenarios
      const topScenarios = db
        .select({
          scenario: schema.alerts.scenario,
          count: sql<number>`count(*) as count`,
        })
        .from(schema.alerts)
        .where(sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined)
        .groupBy(schema.alerts.scenario)
        .orderBy(sql`count desc`)
        .limit(10)
        .all();

      // Top countries
      const topCountries = db
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
        .limit(10)
        .all();

      return {
        total: totalResult?.total || 0,
        filtered: totalResult?.filtered || 0,
        forwarded: totalResult?.forwarded || 0,
        topScenarios: topScenarios.map((s) => ({
          scenario: s.scenario,
          count: s.count,
        })),
        topCountries: topCountries.map((c) => ({
          country: c.country || 'Unknown',
          count: c.count,
        })),
      };
    },

    async cleanup(retentionDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);

      const result = db
        .delete(schema.alerts)
        .where(lte(schema.alerts.receivedAt, cutoff.toISOString()))
        .run();

      return result.changes;
    },
  };
}
