import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  alertDetailHref,
  alertMatchesFilters,
  parseFilterParams,
  parseReturnPath,
  writeFilterParams,
  type FilterState,
} from '../dashboard/lib/alertFilters.js';
import type { StoredAlert } from '../dashboard/lib/types.js';

function makeAlert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: 1,
    machineId: 'srv-01',
    scenario: 'crowdsecurity/ssh-bf',
    receivedAt: '2026-10-20T12:00:00.000Z',
    simulated: false,
    hasDecisions: true,
    filtered: false,
    forwardedToCapi: true,
    replicated: false,
    ...overrides,
  } as StoredAlert;
}

describe('filter query string', () => {
  it('should round-trip all filters', () => {
    const filters: FilterState = {
      since: new Date('2026-10-01T00:00:00.000Z'),
      until: new Date('2026-10-02T00:00:00.000Z'),
      scenario: 'crowdsecurity/ssh-bf',
      machineId: 'srv-01',
      status: 'filtered',
    };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);
    expect(parseFilterParams(new URLSearchParams(params.toString()))).toEqual(filters);
  });

  it('should remove unset filters and keep unrelated parameters', () => {
    const params = new URLSearchParams('machine=srv-01&status=forwarded&other=1');
    writeFilterParams(params, DEFAULT_FILTERS);
    expect(params.toString()).toBe('other=1');
  });

  it('should ignore invalid values', () => {
    const filters = parseFilterParams(new URLSearchParams('since=garbage&status=bogus&machine='));
    expect(filters).toEqual(DEFAULT_FILTERS);
  });
});

describe('alertMatchesFilters', () => {
  it('should match everything with default filters', () => {
    expect(alertMatchesFilters(makeAlert(), DEFAULT_FILTERS)).toBe(true);
  });

  it('should filter by machine, status and scenario (case-insensitive substring)', () => {
    const alert = makeAlert();
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, machineId: 'srv-02' })).toBe(false);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, status: 'filtered' })).toBe(false);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, status: 'forwarded' })).toBe(true);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, scenario: 'SSH' })).toBe(true);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, scenario: 'http' })).toBe(false);
  });

  it('should filter by time range', () => {
    const alert = makeAlert();
    const before = new Date('2026-10-19T00:00:00.000Z');
    const after = new Date('2026-10-21T00:00:00.000Z');
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, since: before, until: after })).toBe(
      true
    );
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, since: after })).toBe(false);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, until: before })).toBe(false);
  });
});

describe('parseReturnPath', () => {
  it('should accept alert lists with their query string', () => {
    expect(parseReturnPath('/alerts?machine=srv-01')).toEqual({
      href: '/alerts?machine=srv-01',
      label: 'Alerts',
    });
    expect(parseReturnPath('/?status=filtered')).toEqual({
      href: '/?status=filtered',
      label: 'Dashboard',
    });
  });

  it('should reject external or unknown targets', () => {
    expect(parseReturnPath(undefined)).toBeNull();
    expect(parseReturnPath('https://evil.example/alerts')).toBeNull();
    expect(parseReturnPath('//evil.example/alerts')).toBeNull();
    expect(parseReturnPath('/\\evil.example/alerts')).toBeNull();
    expect(parseReturnPath('/decisions')).toBeNull();
    expect(parseReturnPath('/alerts/12')).toBeNull();
  });
});

describe('alertDetailHref', () => {
  it('should encode the return path', () => {
    expect(alertDetailHref(42, '/alerts?machine=srv-01&status=filtered')).toBe(
      '/alerts/42?from=%2Falerts%3Fmachine%3Dsrv-01%26status%3Dfiltered'
    );
    expect(alertDetailHref(42, undefined)).toBe('/alerts/42');
  });
});
