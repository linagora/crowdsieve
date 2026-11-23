/**
 * Filters page helpers (dashboard/lib/filterRules.ts) and the `rule` filter of
 * the Alerts page (dashboard/lib/alertFilters.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  alertMatchesFilters,
  alertRuleNames,
  parseFilterParams,
  writeFilterParams,
} from '../dashboard/lib/alertFilters.js';
import {
  matchCountLabel,
  modeDescription,
  parseAlertIdInput,
  periodSince,
  ruleAlertsHref,
  sortRules,
  testResultText,
  type FilterRuleInfo,
} from '../dashboard/lib/filterRules.js';
import type { StoredAlert } from '../dashboard/lib/types.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function makeAlert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: 1,
    scenario: 'crowdsecurity/ssh-bf',
    receivedAt: '2026-11-20T11:00:00.000Z',
    simulated: false,
    hasDecisions: true,
    filtered: true,
    forwardedToCapi: false,
    replicated: false,
    ...overrides,
  } as StoredAlert;
}

describe('rule filter of the Alerts page', () => {
  it('reads and writes the rule URL parameter', () => {
    const filters = parseFilterParams(new URLSearchParams('status=filtered&rule=internal-ips'));
    expect(filters.rule).toBe('internal-ips');
    expect(filters.status).toBe('filtered');

    const params = new URLSearchParams('rule=old&other=1');
    writeFilterParams(params, { ...DEFAULT_FILTERS, rule: 'no-decision' });
    expect(params.get('rule')).toBe('no-decision');
    writeFilterParams(params, DEFAULT_FILTERS);
    expect(params.has('rule')).toBe(false);
    expect(params.get('other')).toBe('1');
  });

  it('defaults to no rule', () => {
    expect(parseFilterParams(new URLSearchParams('rule=')).rule).toBeNull();
    expect(DEFAULT_FILTERS.rule).toBeNull();
  });

  it('parses the stored rule names defensively', () => {
    expect(alertRuleNames(makeAlert({ filterRules: '["a","b"]' }))).toEqual(['a', 'b']);
    expect(alertRuleNames(makeAlert({ filterRules: null }))).toEqual([]);
    expect(alertRuleNames(makeAlert({ filterRules: undefined }))).toEqual([]);
    expect(alertRuleNames(makeAlert({ filterRules: 'not json' }))).toEqual([]);
    expect(alertRuleNames(makeAlert({ filterRules: '{"a":1}' }))).toEqual([]);
    expect(alertRuleNames(makeAlert({ filterRules: '["a",1,null]' }))).toEqual(['a']);
  });

  it('matches alerts by exact rule name; older alerts match no rule', () => {
    const filters = { ...DEFAULT_FILTERS, rule: 'internal-ips' };
    expect(alertMatchesFilters(makeAlert({ filterRules: '["internal-ips"]' }), filters)).toBe(true);
    expect(alertMatchesFilters(makeAlert({ filterRules: '["internal-ips-v2"]' }), filters)).toBe(
      false
    );
    expect(alertMatchesFilters(makeAlert({ filterRules: null }), filters)).toBe(false);
    expect(alertMatchesFilters(makeAlert({ filterRules: null }), DEFAULT_FILTERS)).toBe(true);
  });
});

describe('Filters page helpers', () => {
  const rule = (name: string, enabled: boolean): FilterRuleInfo => ({
    name,
    enabled,
    description: null,
    file: null,
    condition: '',
  });

  it('lists enabled rules first, keeping the load order', () => {
    const sorted = sortRules([
      rule('a', false),
      rule('b', true),
      rule('c', false),
      rule('d', true),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('computes the start of a period', () => {
    expect(periodSince('7d', NOW)?.toISOString()).toBe('2026-11-13T12:00:00.000Z');
    expect(periodSince('30d', NOW)?.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(periodSince('all', NOW)).toBeNull();
  });

  it('describes the mode', () => {
    expect(modeDescription('block')).toBe(
      'alerts matching any enabled rule are not forwarded to CAPI'
    );
    expect(modeDescription('allow')).toBe(
      'only alerts matching an enabled rule are forwarded to CAPI'
    );
  });

  it('labels the counts', () => {
    expect(matchCountLabel(1204, 'block')).toBe('Filtered 1,204 alerts');
    expect(matchCountLabel(1, 'block')).toBe('Filtered 1 alert');
    expect(matchCountLabel(3, 'allow')).toBe('Matched 3 alerts');
  });

  it('links a rule to its alerts in the period', () => {
    expect(ruleAlertsHref('internal-ips', 'block', 'all', NOW)).toBe(
      '/alerts?status=filtered&rule=internal-ips'
    );
    const href = new URL(ruleAlertsHref('a b&c', 'block', '7d', NOW), 'http://x');
    expect(href.pathname).toBe('/alerts');
    expect(href.searchParams.get('rule')).toBe('a b&c');
    expect(href.searchParams.get('range')).toBe('7d');
    expect(href.searchParams.get('since')).toBe('2026-11-13T12:00:00.000Z');
    // The link round-trips through the Alerts page URL parser
    const filters = parseFilterParams(href.searchParams);
    expect(filters).toMatchObject({ rule: 'a b&c', status: 'filtered', range: '7d' });
    expect(ruleAlertsHref('x', 'allow', 'all', NOW)).toBe('/alerts?rule=x');
  });

  it('words the test result', () => {
    const internal = { name: 'internal-ips', reason: 'source.ip in CIDR 10.0.0.0/8' };
    expect(testResultText({ filtered: true, matched: [internal] }, 'block')).toBe(
      'Would be filtered by: internal-ips (source.ip in CIDR 10.0.0.0/8)'
    );
    expect(
      testResultText(
        { filtered: true, matched: [internal, { name: 'no-decision', reason: null }] },
        'block'
      )
    ).toBe('Would be filtered by: internal-ips (source.ip in CIDR 10.0.0.0/8), no-decision');
    expect(testResultText({ filtered: false, matched: [] }, 'block')).toBe(
      'Would be forwarded: no rule matches'
    );
    expect(testResultText({ filtered: true, matched: [] }, 'allow')).toBe(
      'Would be filtered: no rule matches'
    );
    expect(testResultText({ filtered: false, matched: [internal] }, 'allow')).toBe(
      'Would be forwarded, allowed by: internal-ips (source.ip in CIDR 10.0.0.0/8)'
    );
  });

  it('parses the alert ID field', () => {
    expect(parseAlertIdInput(' 42 ')).toBe(42);
    expect(parseAlertIdInput('#7')).toBe(7);
    for (const bad of ['', '0', '-1', '1.5', 'abc', '99999999999999999999']) {
      expect(parseAlertIdInput(bad)).toBeNull();
    }
  });
});
