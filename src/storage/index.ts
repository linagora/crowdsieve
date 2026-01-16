import { eq, desc, and, or, gte, lte, like, sql } from 'drizzle-orm';
import net from 'net';
import type { Alert } from '../models/alert.js';
import type { FilterEngineResult } from '../filters/types.js';
import { getDatabaseContext } from '../db/index.js';
import type { GeoIPInfo } from '../models/alert.js';

/**
 * Escape SQL LIKE wildcards to prevent injection.
 * Backslash must be escaped FIRST to avoid double-escaping.
 */
function escapeLikePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, '\\\\')  // Escape backslash first
    .replace(/[%_]/g, '\\$&'); // Then escape LIKE wildcards
}

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
  topScenarios: Array<{ scenario: string; count: number }>;
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
  getTimeDistributionStats(since?: Date): Promise<TimeDistributionStats>;
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
        // Validate IP before GeoIP lookup to avoid silent failures
        const ipToLookup = alert.source.ip || alert.source.value || '';
        const geoip = net.isIP(ipToLookup) ? geoipLookup?.(ipToLookup) || null : null;

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

    async getTimeDistributionStats(since) {
      const { db, schema, isPostgres } = getDatabaseContext();
      const sinceDate = since?.toISOString();
      const sinceCondition = sinceDate ? gte(schema.alerts.receivedAt, sinceDate) : undefined;

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
        .where(sinceCondition)
        .groupBy(dayOfWeekExpr)
        .orderBy(dayOfWeekExpr);

      // Query: Alerts by hour of day
      const hourOfDayQuery = db
        .select({
          hour: hourOfDayExpr,
          count: sql<number>`count(*)`,
        })
        .from(schema.alerts)
        .where(sinceCondition)
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
        .where(
          and(sinceCondition, sql`${schema.alerts.geoCountryCode} is not null`)
        )
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
        .where(sinceCondition)
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
        .where(sinceCondition)
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
        .where(sinceCondition);

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
      let summary:
        | { total: number; minDate: string | null; maxDate: string | null }
        | undefined;

      if (isPostgres) {
        [byDayOfWeek, byHourOfDay, byCountry, byScenario, dailyTrend, summary] =
          await Promise.all([
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
          const countryName =
            countryCode === 'Unknown' ? 'Unknown' : c.countryName || countryCode;
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
