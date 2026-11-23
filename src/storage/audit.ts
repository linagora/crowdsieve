/**
 * Read side of the audit log: the manual bans and unbans recorded by
 * POST /api/decisions/ban and DELETE /api/decisions/:id.
 *
 * Only rows written by `recordLocalAuditEvent` are read: `local_audit` is
 * never set by the signals path, so a regular alert (or a forged signal) can
 * never show up in the audit log.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { getDatabaseContext } from '../db/index.js';
import { MANUAL_BAN_AUDIT_SCENARIO, UNBAN_AUDIT_SCENARIO } from './index.js';

export type AuditAction = 'ban' | 'unban';

export const AUDIT_DEFAULT_LIMIT = 50;
/** Upper bound of distinct actors returned for the User filter. */
export const AUDIT_MAX_ACTORS = 1000;

export interface AuditLogQuery {
  /** Exact actor (user identifier). */
  actor?: string;
  action?: AuditAction;
  /** Exact IP address or CIDR range the action targeted. */
  ip?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditLogItem {
  id: number;
  /** When the action was recorded (ISO 8601). */
  at: string;
  action: AuditAction;
  actor: string | null;
  ip: string | null;
  server: string | null;
  /** Remediation type of a ban (`ban`, `captcha`); null for unbans. */
  type: string | null;
  /** Duration of a ban (e.g. `4h`); null for unbans. */
  duration: string | null;
  reason: string | null;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  total: number;
}

// A function, not a module-level constant: ./index.js imports this module, so
// its constants are not initialised yet when this module is evaluated.
function auditScenario(action: AuditAction): string {
  return action === 'ban' ? MANUAL_BAN_AUDIT_SCENARIO : UNBAN_AUDIT_SCENARIO;
}

interface AuditRow {
  id: number;
  receivedAt: string;
  scenario: string;
  actor: string | null;
  sourceValue: string | null;
  auditServer: string | null;
  auditType: string | null;
  auditDuration: string | null;
  message: string | null;
  rawJson: string | null;
}

function auditConditions(
  schema: ReturnType<typeof getDatabaseContext>['schema'],
  query: Omit<AuditLogQuery, 'limit' | 'offset'>
) {
  return and(
    eq(schema.alerts.localAudit, true),
    query.action
      ? eq(schema.alerts.scenario, auditScenario(query.action))
      : inArray(schema.alerts.scenario, [auditScenario('ban'), auditScenario('unban')]),
    query.actor ? eq(schema.alerts.actor, query.actor) : undefined,
    query.ip ? eq(schema.alerts.sourceValue, query.ip) : undefined,
    query.since ? gte(schema.alerts.receivedAt, query.since.toISOString()) : undefined,
    query.until ? lte(schema.alerts.receivedAt, query.until.toISOString()) : undefined
  );
}

/**
 * Rows recorded before the audit columns existed only carry the server and
 * the duration in `raw_json` (written by CrowdSieve itself).
 */
function legacyFields(rawJson: string | null): { server?: string; duration?: string } {
  if (!rawJson) return {};
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object') return {};
    const { server, duration } = parsed as Record<string, unknown>;
    return {
      server: typeof server === 'string' ? server : undefined,
      duration: typeof duration === 'string' ? duration : undefined,
    };
  } catch {
    return {};
  }
}

function toItem(row: AuditRow): AuditLogItem {
  const action: AuditAction = row.scenario === UNBAN_AUDIT_SCENARIO ? 'unban' : 'ban';
  const legacy =
    row.auditServer === null || (action === 'ban' && row.auditDuration === null)
      ? legacyFields(row.rawJson)
      : {};
  return {
    id: Number(row.id),
    at: row.receivedAt,
    action,
    actor: row.actor,
    ip: row.sourceValue,
    server: row.auditServer ?? legacy.server ?? null,
    type: action === 'ban' ? (row.auditType ?? 'ban') : null,
    duration: action === 'ban' ? (row.auditDuration ?? legacy.duration ?? null) : null,
    reason: row.message,
  };
}

/** Manual bans and unbans matching `query`, newest first, with the total count. */
export async function queryAuditLog(query: AuditLogQuery): Promise<AuditLogPage> {
  const { db, schema, isPostgres } = getDatabaseContext();
  const where = auditConditions(schema, query);

  const totalQuery = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.alerts)
    .where(where);
  const itemsQuery = db
    .select({
      id: schema.alerts.id,
      receivedAt: schema.alerts.receivedAt,
      scenario: schema.alerts.scenario,
      actor: schema.alerts.actor,
      sourceValue: schema.alerts.sourceValue,
      auditServer: schema.alerts.auditServer,
      auditType: schema.alerts.auditType,
      auditDuration: schema.alerts.auditDuration,
      message: schema.alerts.message,
      rawJson: schema.alerts.rawJson,
    })
    .from(schema.alerts)
    .where(where)
    .orderBy(desc(schema.alerts.receivedAt), desc(schema.alerts.id))
    .limit(query.limit ?? AUDIT_DEFAULT_LIMIT)
    .offset(query.offset ?? 0);

  let total: { total: number } | undefined;
  let rows: AuditRow[];
  if (isPostgres) {
    [total, rows] = await Promise.all([
      totalQuery.then((r: Array<{ total: number }>) => r[0]),
      itemsQuery as Promise<AuditRow[]>,
    ]);
  } else {
    total = (totalQuery as unknown as { get(): { total: number } | undefined }).get();
    rows = (itemsQuery as unknown as { all(): AuditRow[] }).all();
  }

  // PostgreSQL returns count(*) as a string (bigint).
  return { items: rows.map(toItem), total: Number(total?.total) || 0 };
}

/** Distinct users who issued a manual ban or an unban, sorted. */
export async function getAuditActors(): Promise<string[]> {
  const { db, schema, isPostgres } = getDatabaseContext();
  const query = db
    .selectDistinct({ actor: schema.alerts.actor })
    .from(schema.alerts)
    .where(and(auditConditions(schema, {}), isNotNull(schema.alerts.actor)))
    .orderBy(schema.alerts.actor)
    .limit(AUDIT_MAX_ACTORS);

  const rows: Array<{ actor: string | null }> = isPostgres
    ? await query
    : (query as unknown as { all(): Array<{ actor: string | null }> }).all();
  return rows.map((r) => r.actor).filter((a): a is string => typeof a === 'string');
}
