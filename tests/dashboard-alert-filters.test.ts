import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  activeTimeRangePreset,
  alertDetailHref,
  alertMatchesFilters,
  alertsHref,
  filtersToAlertQuery,
  hasActiveFilters,
  normalizeCountryCode,
  isValidAlertId,
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
      range: null,
      scenario: 'crowdsecurity/ssh-bf',
      machineId: 'srv-01',
      rule: 'internal-ips',
      status: 'filtered',
      ip: '203.0.113.0/24',
      country: 'FR',
    };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);
    expect(parseFilterParams(new URLSearchParams(params.toString()))).toEqual(filters);
  });

  it('should round-trip the selected time range preset', () => {
    const filters: FilterState = {
      ...DEFAULT_FILTERS,
      since: new Date('2026-10-01T00:00:00.000Z'),
      range: '7d',
    };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);
    expect(params.get('range')).toBe('7d');
    expect(parseFilterParams(new URLSearchParams(params.toString()))).toEqual(filters);
  });

  it('should drop a preset that does not match the custom range', () => {
    const params = new URLSearchParams();
    writeFilterParams(params, {
      ...DEFAULT_FILTERS,
      since: new Date('2026-10-01T00:00:00.000Z'),
      until: new Date('2026-10-02T00:00:00.000Z'),
      range: '24h',
    });
    expect(params.has('range')).toBe(false);
  });

  it('should remove unset filters and keep unrelated parameters', () => {
    const params = new URLSearchParams('machine=srv-01&status=forwarded&other=1');
    writeFilterParams(params, DEFAULT_FILTERS);
    expect(params.toString()).toBe('other=1');
  });

  it('should ignore invalid values', () => {
    const filters = parseFilterParams(
      new URLSearchParams('since=garbage&status=bogus&machine=&ip=not-an-ip&country=France')
    );
    expect(filters).toEqual(DEFAULT_FILTERS);
  });

  it('should read the IP search and country, normalised', () => {
    const filters = parseFilterParams(new URLSearchParams('ip=%202001:DB8::1%20&country=cn'));
    expect(filters.ip).toBe('2001:db8::1');
    expect(filters.country).toBe('CN');

    const params = new URLSearchParams();
    writeFilterParams(params, { ...DEFAULT_FILTERS, ip: '203.0.113.7', country: 'FR' });
    expect(params.toString()).toBe('ip=203.0.113.7&country=FR');
  });

  it('should ignore an unknown or inconsistent range', () => {
    expect(parseFilterParams(new URLSearchParams('range=6h')).range).toBeNull();
    // A preset needs a start and no explicit end
    expect(parseFilterParams(new URLSearchParams('range=24h')).range).toBeNull();
    expect(
      parseFilterParams(
        new URLSearchParams(
          'range=24h&since=2026-10-01T00:00:00.000Z&until=2026-10-02T00:00:00.000Z'
        )
      ).range
    ).toBeNull();
  });
});

describe('activeTimeRangePreset', () => {
  const since = new Date('2026-10-01T00:00:00.000Z');
  const until = new Date('2026-10-02T00:00:00.000Z');

  it('should highlight All when no time filter is set', () => {
    expect(activeTimeRangePreset({ since: null, until: null, range: null })).toBe('all');
  });

  it('should highlight the stored preset even though its date was computed at click time', () => {
    // The date is not recomputed, so the highlight no longer depends on now()
    expect(activeTimeRangePreset({ since, until: null, range: '24h' })).toBe('24h');
    expect(activeTimeRangePreset({ since, until: null, range: '30d' })).toBe('30d');
  });

  it('should not highlight any preset for a custom range', () => {
    expect(activeTimeRangePreset({ since, until: null, range: null })).toBeNull();
    expect(activeTimeRangePreset({ since, until, range: null })).toBeNull();
    expect(activeTimeRangePreset({ since, until, range: '24h' })).toBeNull();
    expect(activeTimeRangePreset({ since: null, until, range: null })).toBeNull();
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

  it('should exclude locally-recorded audit rows from status filters', () => {
    // Audit rows are stored with filtered=true defensively, but they are
    // operator actions, not alerts rejected by the filter rules.
    const manualAudit = makeAlert({
      localAudit: true,
      scenario: 'crowdsieve/manual-audit',
      filtered: true,
      forwardedToCapi: false,
    });
    expect(alertMatchesFilters(manualAudit, { ...DEFAULT_FILTERS, status: 'filtered' })).toBe(
      false
    );
    expect(alertMatchesFilters(manualAudit, { ...DEFAULT_FILTERS, status: 'forwarded' })).toBe(
      false
    );
    expect(alertMatchesFilters(manualAudit, DEFAULT_FILTERS)).toBe(true);

    const unban = makeAlert({
      localAudit: true,
      scenario: 'crowdsieve/unban',
      filtered: true,
      forwardedToCapi: true,
    });
    expect(alertMatchesFilters(unban, { ...DEFAULT_FILTERS, status: 'filtered' })).toBe(false);
    expect(alertMatchesFilters(unban, { ...DEFAULT_FILTERS, status: 'forwarded' })).toBe(false);
  });

  it('should filter by country', () => {
    const alert = makeAlert({ geoCountryCode: 'FR' });
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, country: 'FR' })).toBe(true);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, country: 'CN' })).toBe(false);
    expect(alertMatchesFilters(makeAlert(), { ...DEFAULT_FILTERS, country: 'FR' })).toBe(false);
  });

  it('should filter by IP address or range', () => {
    const alert = makeAlert({ sourceIp: '203.0.113.7', sourceValue: '203.0.113.7' });
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, ip: '203.0.113.7' })).toBe(true);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, ip: '203.0.113.8' })).toBe(false);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, ip: '203.0.113.0/24' })).toBe(true);
    expect(alertMatchesFilters(alert, { ...DEFAULT_FILTERS, ip: '203.0.114.0/24' })).toBe(false);
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

describe('isValidAlertId', () => {
  it('should accept positive integer ids', () => {
    for (const id of ['1', '42', '999999']) {
      expect(isValidAlertId(id)).toBe(true);
    }
  });

  it('should reject ids the proxy would answer with a 400', () => {
    // Regression for #72: these rendered "Cannot Connect to API" instead of 404.
    for (const id of ['abc', '-1', '1.5', '0', '01', ' 1', '1 ', '+1', '1e3', '']) {
      expect(isValidAlertId(id)).toBe(false);
    }
  });
});

describe('hasActiveFilters', () => {
  it('should be false for the defaults only', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, ip: '203.0.113.7' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, country: 'FR' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, status: 'filtered' })).toBe(true);
  });
});

describe('filtersToAlertQuery', () => {
  it('should map every filter to its API parameter', () => {
    expect(
      filtersToAlertQuery({
        since: new Date('2026-10-01T00:00:00.000Z'),
        until: null,
        range: null,
        scenario: 'ssh-bf',
        machineId: 'srv-01',
        status: 'filtered',
        ip: '203.0.113.0/24',
        country: 'FR',
      })
    ).toEqual({
      since: '2026-10-01T00:00:00.000Z',
      until: undefined,
      scenario: 'ssh-bf',
      machineId: 'srv-01',
      filtered: true,
      forwardedToCapi: undefined,
      ip: '203.0.113.0/24',
      country: 'FR',
    });
    expect(filtersToAlertQuery({ ...DEFAULT_FILTERS, status: 'forwarded' })).toMatchObject({
      filtered: undefined,
      forwardedToCapi: true,
    });
  });
});

describe('alertsHref', () => {
  it('should link to the alerts of a country or scenario', () => {
    expect(alertsHref({ country: 'CN' })).toBe('/alerts?country=CN');
    expect(alertsHref({ scenario: 'crowdsecurity/ssh-bf' })).toBe(
      '/alerts?scenario=crowdsecurity%2Fssh-bf'
    );
    expect(alertsHref({})).toBe('/alerts');
  });

  it('should carry a time range preset', () => {
    const since = new Date('2026-10-01T00:00:00.000Z');
    const href = alertsHref({ country: 'CN', since, range: '7d' });
    const filters = parseFilterParams(new URLSearchParams(href.split('?')[1]));
    expect(filters).toEqual({ ...DEFAULT_FILTERS, country: 'CN', since, range: '7d' });
  });
});

describe('normalizeCountryCode', () => {
  it('should accept ISO alpha-2 codes only', () => {
    expect(normalizeCountryCode('fr')).toBe('FR');
    expect(normalizeCountryCode(' CN ')).toBe('CN');
    expect(normalizeCountryCode('FRA')).toBeNull();
    expect(normalizeCountryCode('Unknown')).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
  });
});
