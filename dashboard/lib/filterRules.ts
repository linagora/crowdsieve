/**
 * Types and pure helpers of the Filters page (/filters).
 */
import { isValidAlertId } from './alertFilters';

export type FilterMode = 'block' | 'allow';

export interface FilterRuleInfo {
  name: string;
  description: string | null;
  enabled: boolean;
  /** Name of the file the rule was loaded from */
  file: string | null;
  /** The rule condition, as YAML */
  condition: string;
}

export interface FilterRulesResponse {
  mode: FilterMode;
  rules: FilterRuleInfo[];
}

export interface FilterRuleStats {
  total: number;
  filtered: number;
  byRule: Array<{ name: string; count: number; lastMatchedAt: string | null }>;
}

export interface FilterTestResult {
  filtered: boolean;
  matched: Array<{ name: string; reason: string | null }>;
}

export const FILTER_PERIODS = ['7d', '30d', 'all'] as const;
export type FilterPeriod = (typeof FILTER_PERIODS)[number];

export const FILTER_PERIOD_LABELS: Record<FilterPeriod, string> = {
  '7d': '7 days',
  '30d': '30 days',
  all: 'All',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the period, or null for all time. */
export function periodSince(period: FilterPeriod, now: Date = new Date()): Date | null {
  if (period === 'all') return null;
  return new Date(now.getTime() - (period === '7d' ? 7 : 30) * DAY_MS);
}

/** Enabled rules first, each group in load (evaluation) order. */
export function sortRules(rules: FilterRuleInfo[]): FilterRuleInfo[] {
  return [...rules.filter((r) => r.enabled), ...rules.filter((r) => !r.enabled)];
}

export function modeDescription(mode: FilterMode): string {
  return mode === 'block'
    ? 'alerts matching any enabled rule are not forwarded to CAPI'
    : 'only alerts matching an enabled rule are forwarded to CAPI';
}

/** "Filtered 1,204 alerts" in block mode, "Matched …" in allow mode. */
export function matchCountLabel(count: number, mode: FilterMode): string {
  const verb = mode === 'block' ? 'Filtered' : 'Matched';
  return `${verb} ${count.toLocaleString('en-US')} alert${count === 1 ? '' : 's'}`;
}

/**
 * Alerts page showing the alerts a rule matched in the period. In block mode
 * they are all filtered alerts; in allow mode they are the forwarded ones, so
 * no status is set.
 */
export function ruleAlertsHref(
  name: string,
  mode: FilterMode,
  period: FilterPeriod,
  now: Date = new Date()
): string {
  const params = new URLSearchParams();
  if (mode === 'block') params.set('status', 'filtered');
  params.set('rule', name);
  const since = periodSince(period, now);
  if (since) {
    params.set('since', since.toISOString());
    params.set('range', period);
  }
  return `/alerts?${params}`;
}

function describeMatches(matched: FilterTestResult['matched']): string {
  return matched.map((m) => (m.reason ? `${m.name} (${m.reason})` : m.name)).join(', ');
}

/** Sentence shown for the result of "Test an alert". */
export function testResultText(result: FilterTestResult, mode: FilterMode): string {
  if (mode === 'block') {
    return result.filtered
      ? `Would be filtered by: ${describeMatches(result.matched)}`
      : 'Would be forwarded: no rule matches';
  }
  return result.filtered
    ? 'Would be filtered: no rule matches'
    : `Would be forwarded, allowed by: ${describeMatches(result.matched)}`;
}

/** Parse the "Alert ID" field; null unless it is a positive integer. */
export function parseAlertIdInput(value: string): number | null {
  const trimmed = value.trim().replace(/^#/, '');
  if (!isValidAlertId(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : null;
}
