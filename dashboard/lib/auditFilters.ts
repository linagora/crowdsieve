/**
 * URL state and formatting helpers of the audit log page (/audit).
 */
import type { AuditAction, AuditLogItem } from './types';

export const AUDIT_PAGE_SIZE = 50;
/** Page size used to fetch every filtered row for the CSV export (proxy maximum). */
export const AUDIT_EXPORT_PAGE_SIZE = 1000;

export const AUDIT_PERIODS = ['24h', '7d', '30d', 'all'] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

export const AUDIT_PERIOD_LABELS: Record<AuditPeriod, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

const PERIOD_MS: Record<Exclude<AuditPeriod, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface AuditFilters {
  actor: string | null;
  action: AuditAction | 'all';
  /** IP address or CIDR range, matched exactly. */
  ip: string | null;
  period: AuditPeriod;
  /** 1-based page number. */
  page: number;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  actor: null,
  action: 'all',
  ip: null,
  period: 'all',
  page: 1,
};

const PARAM_ACTOR = 'user';
const PARAM_ACTION = 'action';
const PARAM_IP = 'ip';
const PARAM_PERIOD = 'period';
const PARAM_PAGE = 'page';

// Same bound as the proxy (MAX_ACTOR_LENGTH).
const MAX_ACTOR_LENGTH = 256;

export function parseAuditParams(params: URLSearchParams): AuditFilters {
  const actor = params.get(PARAM_ACTOR)?.trim().slice(0, MAX_ACTOR_LENGTH) || null;
  const action = params.get(PARAM_ACTION);
  const ip = params.get(PARAM_IP)?.trim() || null;
  const period = params.get(PARAM_PERIOD);
  const page = Number(params.get(PARAM_PAGE));
  return {
    actor,
    action: action === 'ban' || action === 'unban' ? action : 'all',
    ip,
    period: (AUDIT_PERIODS as readonly string[]).includes(period ?? '')
      ? (period as AuditPeriod)
      : 'all',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** Write filters into `params`, removing keys of unset filters. */
export function writeAuditParams(params: URLSearchParams, filters: AuditFilters): void {
  const entries: Array<[string, string | null]> = [
    [PARAM_ACTOR, filters.actor],
    [PARAM_ACTION, filters.action === 'all' ? null : filters.action],
    [PARAM_IP, filters.ip],
    [PARAM_PERIOD, filters.period === 'all' ? null : filters.period],
    [PARAM_PAGE, filters.page > 1 ? String(filters.page) : null],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
}

export function hasActiveAuditFilters(filters: AuditFilters): boolean {
  return (
    filters.actor !== null ||
    filters.action !== 'all' ||
    filters.ip !== null ||
    filters.period !== 'all'
  );
}

/**
 * Query string of GET /api/audit for `filters`. The period is turned into a
 * `since` date relative to `now`; `until` pins the upper bound (CSV export).
 */
export function buildAuditApiQuery(
  filters: AuditFilters,
  now: Date,
  page: { limit: number; offset: number; until?: Date }
): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.actor) query.set('actor', filters.actor);
  if (filters.action !== 'all') query.set('action', filters.action);
  if (filters.ip) query.set('ip', filters.ip);
  if (filters.period !== 'all') {
    query.set('since', new Date(now.getTime() - PERIOD_MS[filters.period]).toISOString());
  }
  if (page.until) query.set('until', page.until.toISOString());
  query.set('limit', String(page.limit));
  query.set('offset', String(page.offset));
  return query;
}

/** "Details" column: "captcha · 2h" for a ban, empty for an unban. */
export function formatAuditDetails(item: Pick<AuditLogItem, 'type' | 'duration'>): string {
  return [item.type, item.duration].filter(Boolean).join(' · ');
}

/** "1–50 of 132"; "0 of 0" when there is nothing to show. */
export function auditRangeLabel(offset: number, count: number, total: number): string {
  if (count === 0) return `0 of ${total}`;
  return `${offset + 1}–${offset + count} of ${total}`;
}

export function auditPageCount(total: number, pageSize = AUDIT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** `crowdsieve-audit-<YYYYMMDD-HHmm>.csv`, in the browser's local time. */
export function auditCsvFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `crowdsieve-audit-${stamp}.csv`;
}
