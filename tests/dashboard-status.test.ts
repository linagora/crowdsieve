import { describe, expect, it } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  formatBouncerDetails,
  isStale,
} from '../dashboard/lib/bouncerStatus.js';
import { formatAgo } from '../dashboard/lib/relativeTime.js';
import { bannerMessage, summaryLabel } from '../dashboard/lib/status.js';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const MIN = 60_000;

describe('isStale', () => {
  it('uses a 2 hour threshold', () => {
    expect(STALE_THRESHOLD_MS).toBe(2 * 60 * MIN);
  });

  it('is false for a recent report', () => {
    expect(isStale(NOW - 12 * MIN, NOW)).toBe(false);
  });

  it('is false at exactly 2 hours and true just after', () => {
    expect(isStale(NOW - 120 * MIN, NOW)).toBe(false);
    expect(isStale(NOW - 120 * MIN - 1, NOW)).toBe(true);
  });

  it('is true for a report 3 hours old', () => {
    expect(isStale(NOW - 180 * MIN, NOW)).toBe(true);
  });

  it('is false when the last report is unknown', () => {
    expect(isStale(null, NOW)).toBe(false);
    expect(isStale(undefined, NOW)).toBe(false);
    expect(isStale(NaN, NOW)).toBe(false);
  });

  it('accepts a custom threshold', () => {
    expect(isStale(NOW - 10 * MIN, NOW, 5 * MIN)).toBe(true);
  });
});

describe('formatAgo', () => {
  it('renders seconds, minutes, hours and days', () => {
    expect(formatAgo(NOW - 1000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 20_000, NOW)).toBe('20 s ago');
    expect(formatAgo(NOW - 12 * MIN, NOW)).toBe('12 min ago');
    expect(formatAgo(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago');
    expect(formatAgo(NOW - 72 * 60 * MIN, NOW)).toBe('3 d ago');
  });

  it('never goes negative when the clock is behind', () => {
    expect(formatAgo(NOW + MIN, NOW)).toBe('just now');
  });
});

describe('formatBouncerDetails', () => {
  it('renders last report, version and OS', () => {
    expect(
      formatBouncerDetails(
        { lastSeenAt: NOW - 12 * MIN, version: 'v1.6.4', osName: 'Linux', osVersion: 'Debian 12' },
        NOW
      )
    ).toBe('Last report 12 min ago · v1.6.4 · Linux (Debian 12)');
  });

  it('prefixes a bare version with v', () => {
    expect(formatBouncerDetails({ lastSeenAt: NOW - MIN, version: '1.6.4' }, NOW)).toBe(
      'Last report 1 min ago · v1.6.4'
    );
  });

  it('omits version and OS when unknown', () => {
    expect(
      formatBouncerDetails(
        { lastSeenAt: NOW - MIN, version: null, osName: null, osVersion: null },
        NOW
      )
    ).toBe('Last report 1 min ago');
  });

  it('renders the OS without version', () => {
    expect(formatBouncerDetails({ lastSeenAt: NOW, osName: 'freebsd', osVersion: null }, NOW)).toBe(
      'Last report just now · freebsd'
    );
  });
});

describe('status banner texts', () => {
  it('names an unreachable LAPI', () => {
    expect(
      bannerMessage({ kind: 'lapi', server: 'lapi-qa', since: NOW, message: 'unreachable' })
    ).toBe('LAPI lapi-qa is unreachable');
  });

  it('mentions the start of a CAPI failure', () => {
    expect(bannerMessage({ kind: 'capi', since: NOW, message: 'x' })).toMatch(
      /^CAPI forwarding is failing since \d\d:\d\d$/
    );
    expect(bannerMessage({ kind: 'capi', since: null, message: 'x' })).toBe(
      'CAPI forwarding is failing'
    );
  });

  it('summarizes the number of problems', () => {
    expect(summaryLabel({ problems: [] })).toBe('All systems operational');
    const p = { kind: 'capi' as const, since: null, message: 'x' };
    expect(summaryLabel({ problems: [p] })).toBe('1 problem');
    expect(summaryLabel({ problems: [p, p] })).toBe('2 problems');
  });
});
