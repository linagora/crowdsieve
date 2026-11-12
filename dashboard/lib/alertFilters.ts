import type { StoredAlert } from './types';

export const TIME_RANGE_PRESETS = ['24h', '7d', '30d'] as const;

export type TimeRangePreset = (typeof TIME_RANGE_PRESETS)[number];

export interface FilterState {
  since: Date | null;
  until: Date | null;
  /**
   * Preset the range was picked from, if any. Kept separately from `since`
   * because a preset date is computed at click time: comparing it with a
   * date recomputed on render would never match.
   */
  range: TimeRangePreset | null;
  scenario: string | null;
  machineId: string | null;
  status: 'all' | 'filtered' | 'forwarded';
}

export const DEFAULT_FILTERS: FilterState = {
  since: null,
  until: null,
  range: null,
  scenario: null,
  machineId: null,
  status: 'all',
};

// Query string keys used to persist filters in the URL
const PARAM_SINCE = 'since';
const PARAM_UNTIL = 'until';
const PARAM_RANGE = 'range';
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

function parseTimeRangePreset(value: string | null): TimeRangePreset | null {
  if (!value) return null;
  return (TIME_RANGE_PRESETS as readonly string[]).includes(value)
    ? (value as TimeRangePreset)
    : null;
}

/**
 * A preset only makes sense for a range that starts at `since` and has no
 * explicit end: the slider or the calendar clear it when they set one.
 */
function normalizeRange(
  range: TimeRangePreset | null,
  since: Date | null,
  until: Date | null
): TimeRangePreset | null {
  return range && since && !until ? range : null;
}

/**
 * Preset to highlight for the current filters: a preset id, 'all' when no time
 * filter is set, or null for a custom range (slider or calendar).
 */
export function activeTimeRangePreset(
  filters: Pick<FilterState, 'since' | 'until' | 'range'>
): TimeRangePreset | 'all' | null {
  if (!filters.since && !filters.until) return 'all';
  return normalizeRange(filters.range, filters.since, filters.until);
}

export function parseFilterParams(params: URLSearchParams): FilterState {
  const status = params.get(PARAM_STATUS);
  const since = parseDate(params.get(PARAM_SINCE));
  const until = parseDate(params.get(PARAM_UNTIL));
  return {
    since,
    until,
    range: normalizeRange(parseTimeRangePreset(params.get(PARAM_RANGE)), since, until),
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
    [PARAM_RANGE, normalizeRange(filters.range, filters.since, filters.until)],
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
  // Locally-recorded audit rows are operator actions, not alerts rejected by
  // the filter rules, even though they are stored with filtered=true.
  if (filters.status === 'filtered' && (!alert.filtered || alert.localAudit)) return false;
  if (filters.status === 'forwarded' && (!alert.forwardedToCapi || alert.localAudit)) return false;
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

/**
 * Alert ids are positive integers. Anything else (`abc`, `-1`, `1.5`) must be
 * treated as a missing alert: the proxy rejects such ids with a 400, which
 * would otherwise be rendered as a misleading "Cannot Connect to API" error.
 */
export function isValidAlertId(id: string): boolean {
  return /^[1-9]\d*$/.test(id);
}
