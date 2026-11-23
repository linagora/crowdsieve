import { describe, expect, it } from 'vitest';
import {
  alertCountLabel,
  appendAlertPage,
  mergeRefreshedAlerts,
} from '../dashboard/lib/alertPaging.js';
import { clusterCountry } from '../dashboard/lib/mapCluster.js';

const ids = (list: Array<{ id: number }>) => list.map((a) => a.id);
const alerts = (...list: number[]) => list.map((id) => ({ id }));

describe('appendAlertPage', () => {
  it('appends the next page', () => {
    expect(ids(appendAlertPage(alerts(9, 8), alerts(7, 6)))).toEqual([9, 8, 7, 6]);
  });

  it('drops alerts already listed (offsets shifted by new alerts)', () => {
    expect(ids(appendAlertPage(alerts(9, 8, 7), alerts(7, 6, 5)))).toEqual([9, 8, 7, 6, 5]);
  });

  it('keeps the same list when nothing is new', () => {
    const current = alerts(9, 8);
    expect(appendAlertPage(current, alerts(8))).toBe(current);
  });
});

describe('mergeRefreshedAlerts', () => {
  it('adds new alerts at the top and keeps the loaded pages', () => {
    const merged = mergeRefreshedAlerts(alerts(10, 9, 8, 7, 6, 5), alerts(12, 11, 10, 9));
    expect(merged.reset).toBe(false);
    expect(ids(merged.alerts)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
  });

  it('restarts from the fresh page when it does not reach the listed alerts', () => {
    const merged = mergeRefreshedAlerts(alerts(10, 9, 8), alerts(15, 14, 13));
    expect(merged.reset).toBe(true);
    expect(ids(merged.alerts)).toEqual([15, 14, 13]);
  });

  it('uses the fresh page for an empty list', () => {
    expect(mergeRefreshedAlerts([], alerts(1))).toEqual({ alerts: alerts(1), reset: true });
  });
});

describe('alertCountLabel', () => {
  it('tells whether more alerts are available', () => {
    expect(alertCountLabel(300, true)).toBe('Showing 300 alerts — more available');
    expect(alertCountLabel(312, false)).toBe('Showing 312 alerts');
    expect(alertCountLabel(1, false)).toBe('Showing 1 alert');
    expect(alertCountLabel(1200, false)).toBe('Showing 1,200 alerts');
  });
});

describe('clusterCountry', () => {
  it('returns the most frequent country of a map cluster', () => {
    expect(
      clusterCountry([
        { geoCountryCode: 'FR' },
        { geoCountryCode: 'BE' },
        { geoCountryCode: 'FR' },
        { geoCountryCode: undefined },
      ])
    ).toBe('FR');
    expect(clusterCountry([{ geoCountryCode: undefined }])).toBeNull();
  });
});
