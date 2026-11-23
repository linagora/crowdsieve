/**
 * Active decisions table of the Decisions page: URL-persisted filters, the
 * query sent to `/api/decisions/active`, row flattening/sorting and paging.
 */
import type { ActiveDecisionsServerResult, Decision } from './types';
import { decisionExpiry, expiryRemainingMs, type DecisionExpiry } from './decisionExpiry';

export const ACTIVE_DECISIONS_PAGE_SIZE = 50;

/** Origins of the community blocklists (same list as the proxy). */
export const SHARED_ORIGINS = ['CAPI', 'lists'] as const;

export function isSharedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase();
  return SHARED_ORIGINS.some((o) => o.toLowerCase() === lower);
}

export interface ActiveDecisionFilters {
  server: string | null;
  type: string | null;
  origin: string | null;
  /** IP (decisions containing it) or CIDR (decisions inside it), as typed. */
  value: string;
  /** Case-insensitive substring of the scenario, as typed. */
  scenario: string;
  includeShared: boolean;
}

export const DEFAULT_ACTIVE_DECISION_FILTERS: ActiveDecisionFilters = {
  server: null,
  type: null,
  origin: null,
  value: '',
  scenario: '',
  includeShared: false,
};

// Query string keys on /decisions. `ip` belongs to the search form.
const PARAM_SERVER = 'server';
const PARAM_TYPE = 'type';
const PARAM_ORIGIN = 'origin';
const PARAM_VALUE = 'value';
const PARAM_SCENARIO = 'scenario';
const PARAM_SHARED = 'shared';

const SERVER_RE = /^[a-zA-Z0-9_-]+$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ORIGIN_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const MAX_VALUE_LENGTH = 64;
const MAX_SCENARIO_LENGTH = 200;

function pick(value: string | null, re: RegExp): string | null {
  return value && re.test(value) ? value : null;
}

/** Read the filters from the query string; invalid values are ignored. */
export function parseActiveDecisionParams(params: URLSearchParams): ActiveDecisionFilters {
  const shared = params.get(PARAM_SHARED);
  return {
    server: pick(params.get(PARAM_SERVER), SERVER_RE),
    type: pick(params.get(PARAM_TYPE), TOKEN_RE),
    origin: pick(params.get(PARAM_ORIGIN), ORIGIN_RE),
    value: (params.get(PARAM_VALUE) ?? '').slice(0, MAX_VALUE_LENGTH),
    scenario: (params.get(PARAM_SCENARIO) ?? '').slice(0, MAX_SCENARIO_LENGTH),
    includeShared: shared === '1' || shared === 'true',
  };
}

/**
 * Write the filters into `params`, removing the keys of unset filters.
 * Unrelated query parameters (e.g. the search's `ip`) are left untouched.
 */
export function writeActiveDecisionParams(
  params: URLSearchParams,
  filters: ActiveDecisionFilters
): void {
  const entries: Array<[string, string | null]> = [
    [PARAM_SERVER, filters.server],
    [PARAM_TYPE, filters.type],
    [PARAM_ORIGIN, filters.origin],
    [PARAM_VALUE, filters.value.trim() || null],
    [PARAM_SCENARIO, filters.scenario.trim() || null],
    [PARAM_SHARED, filters.includeShared ? '1' : null],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

function isIPv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    // The WHATWG URL parser implements the full IPv6 address grammar.
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an IP address or CIDR range as accepted by the proxy. Returns the
 * kind of value, or null when it is not valid.
 */
export function ipOrCidrKind(input: string): 'ip' | 'range' | null {
  const value = input.trim();
  if (!value) return null;
  const slash = value.indexOf('/');
  if (slash === -1) return isIPv4(value) || isIPv6(value) ? 'ip' : null;
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  if (isIPv4(address)) return bits <= 32 ? 'range' : null;
  if (isIPv6(address)) return bits <= 128 ? 'range' : null;
  return null;
}

/**
 * Query string for `/api/decisions/active`. The value filter is sent only
 * when it is a valid IP or CIDR (the caller warns about an invalid one).
 */
export function buildActiveDecisionsQuery(filters: ActiveDecisionFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.server) params.set('server', filters.server);
  if (filters.type) params.set('type', filters.type);
  if (filters.origin) params.set('origin', filters.origin);
  const value = filters.value.trim();
  if (value && ipOrCidrKind(value)) params.set('value', value);
  const scenario = filters.scenario.trim();
  if (scenario) params.set('scenario', scenario);
  if (filters.includeShared) params.set('include_shared', 'true');
  return params;
}

export interface ActiveDecisionRow {
  /** Unique key: `<server>#<decision id>`. */
  key: string;
  server: string;
  decision: Decision;
  expiry: DecisionExpiry;
  /** Community blocklist decision: the LAPI would only pull it again. */
  shared: boolean;
}

export function activeDecisionKey(server: string, id: number): string {
  return `${server}#${id}`;
}

/**
 * One row per decision of every server, sorted by expiry (soonest first;
 * decisions without an expiry date last), then by server and value.
 */
export function flattenActiveDecisions(
  results: ActiveDecisionsServerResult[],
  answeredAt: number
): ActiveDecisionRow[] {
  const rows: ActiveDecisionRow[] = [];
  for (const result of results) {
    for (const decision of result.decisions) {
      rows.push({
        key: activeDecisionKey(result.server, decision.id),
        server: result.server,
        decision,
        expiry: decisionExpiry(decision, answeredAt),
        shared: isSharedOrigin(decision.origin),
      });
    }
  }
  return rows.sort((a, b) => {
    const ea = expiryRemainingMs(a.expiry, 0);
    const eb = expiryRemainingMs(b.expiry, 0);
    if (ea !== eb) return ea < eb ? -1 : 1;
    if (a.server !== b.server) return a.server < b.server ? -1 : 1;
    if (a.decision.value !== b.decision.value) return a.decision.value < b.decision.value ? -1 : 1;
    return a.decision.id - b.decision.id;
  });
}

export interface PageWindow {
  /** 0-based page index, clamped to the available pages. */
  page: number;
  pageCount: number;
  /** Slice bounds: rows[start, end). */
  start: number;
  end: number;
}

export function pageWindow(
  total: number,
  page: number,
  pageSize = ACTIVE_DECISIONS_PAGE_SIZE
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1);
  const start = clamped * pageSize;
  return { page: clamped, pageCount, start, end: Math.min(total, start + pageSize) };
}

/** `1–50 of 312`; `0 of 0` for an empty list. */
export function formatPageRange(window: PageWindow, total: number): string {
  if (total === 0) return '0 of 0';
  return `${window.start + 1}–${window.end} of ${total}`;
}
