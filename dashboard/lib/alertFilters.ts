import type { StoredAlert } from './types';

export interface FilterState {
  since: Date | null;
  until: Date | null;
  scenario: string | null;
  machineId: string | null;
  status: 'all' | 'filtered' | 'forwarded';
}

export const DEFAULT_FILTERS: FilterState = {
  since: null,
  until: null,
  scenario: null,
  machineId: null,
  status: 'all',
};

// Query string keys used to persist filters in the URL
const PARAM_SINCE = 'since';
const PARAM_UNTIL = 'until';
const PARAM_SCENARIO = 'scenario';
const PARAM_MACHINE = 'machine';
const PARAM_STATUS = 'status';

// Pages that render an alert list and may be used as a "back" target
const RETURN_PATHS: Record<string, string> = {
  '/': 'Dashboard',
  '/alerts': 'Alerts',
};

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

export function parseFilterParams(params: URLSearchParams): FilterState {
  const status = params.get(PARAM_STATUS);
  return {
    since: parseDate(params.get(PARAM_SINCE)),
    until: parseDate(params.get(PARAM_UNTIL)),
    scenario: params.get(PARAM_SCENARIO) || null,
    machineId: params.get(PARAM_MACHINE) || null,
    status: status === 'filtered' || status === 'forwarded' ? status : 'all',
  };
}

/**
 * Write filters into `params`, removing keys of unset filters.
 * Unrelated query parameters are left untouched.
 */
export function writeFilterParams(params: URLSearchParams, filters: FilterState): void {
  const entries: Array<[string, string | null]> = [
    [PARAM_SINCE, filters.since?.toISOString() ?? null],
    [PARAM_UNTIL, filters.until?.toISOString() ?? null],
    [PARAM_SCENARIO, filters.scenario],
    [PARAM_MACHINE, filters.machineId],
    [PARAM_STATUS, filters.status === 'all' ? null : filters.status],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
}

/**
 * Client-side equivalent of the API filters. Used to avoid showing unfiltered
 * alerts while the filtered list is being fetched (e.g. after a "back" navigation).
 */
export function alertMatchesFilters(alert: StoredAlert, filters: FilterState): boolean {
  if (filters.status === 'filtered' && !alert.filtered) return false;
  if (filters.status === 'forwarded' && !alert.forwardedToCapi) return false;
  if (filters.machineId && alert.machineId !== filters.machineId) return false;
  // The API uses a LIKE '%...%' match; stay case-insensitive so this never
  // hides an alert the API would return
  if (filters.scenario && !alert.scenario.toLowerCase().includes(filters.scenario.toLowerCase())) {
    return false;
  }
  const receivedAt = new Date(alert.receivedAt).getTime();
  if (filters.since && receivedAt < filters.since.getTime()) return false;
  if (filters.until && receivedAt > filters.until.getTime()) return false;
  return true;
}

/**
 * Validate a `from` query parameter so it can only point to a local alert list
 * (prevents open redirects). Returns null if it is not acceptable.
 */
export function parseReturnPath(
  from: string | null | undefined
): { href: string; label: string } | null {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(from, 'http://localhost');
  } catch {
    return null;
  }
  if (url.origin !== 'http://localhost') return null;
  const label = RETURN_PATHS[url.pathname];
  if (!label) return null;
  return { href: `${url.pathname}${url.search}`, label };
}

export function alertDetailHref(alertId: number, from: string | null | undefined): string {
  return from ? `/alerts/${alertId}?from=${encodeURIComponent(from)}` : `/alerts/${alertId}`;
}
