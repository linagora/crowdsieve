import { describe, expect, it } from 'vitest';
import {
  decisionExpiry,
  expiryRemainingMs,
  formatExpiry,
  formatExpiryDate,
  formatRemaining,
  formatRemainingPhrase,
  parseGoDuration,
} from '../dashboard/lib/decisionExpiry.js';

const H = 3_600_000;
const M = 60_000;
const S = 1000;

describe('parseGoDuration', () => {
  it.each([
    ['4h', 4 * H],
    ['3h56m24s', 3 * H + 56 * M + 24 * S],
    ['3h56m24.5s', 3 * H + 56 * M + 24.5 * S],
    ['23h59m59.999999999s', 23 * H + 59 * M + 59.999999999 * S],
    ['1m30s', 90 * S],
    ['45s', 45 * S],
    ['1.5h', 1.5 * H],
    ['.5s', 500],
    ['250ms', 250],
    ['1500us', 1.5],
    ['1500µs', 1.5],
    ['1500μs', 1.5],
    ['2000000ns', 2],
    ['0', 0],
    ['0s', 0],
    ['+5m', 5 * M],
    [' 2h ', 2 * H],
  ])('parses %s', (text, expected) => {
    expect(parseGoDuration(text)).toBeCloseTo(expected, 6);
  });

  it('parses negative durations (a decision that just expired)', () => {
    expect(parseGoDuration('-1.234ms')).toBeCloseTo(-1.234, 6);
    expect(parseGoDuration('-2m3s')).toBe(-(2 * M + 3 * S));
  });

  it.each(['', '   ', '-', '4', '4d', 'h', '3h56', '1.5.2s', 'forever', '4 h', 'h4', '--1s'])(
    'rejects %j',
    (text) => {
      expect(parseGoDuration(text)).toBeNull();
    }
  );

  it('rejects non-strings', () => {
    expect(parseGoDuration(null)).toBeNull();
    expect(parseGoDuration(undefined)).toBeNull();
  });
});

describe('decisionExpiry', () => {
  const answeredAt = Date.parse('2026-11-11T19:08:00Z');

  it('uses until when present', () => {
    expect(decisionExpiry({ until: '2026-11-12T00:00:00Z', duration: '1h' }, answeredAt)).toEqual({
      kind: 'at',
      date: new Date('2026-11-12T00:00:00Z'),
    });
  });

  it('falls back to the answer time plus the duration', () => {
    expect(decisionExpiry({ duration: '3h56m24.5s' }, answeredAt)).toEqual({
      kind: 'at',
      date: new Date(answeredAt + 3 * H + 56 * M + 24_500),
    });
    expect(decisionExpiry({ until: 'garbage', duration: '1h' }, new Date(answeredAt))).toEqual({
      kind: 'at',
      date: new Date(answeredAt + H),
    });
  });

  it('handles zero and negative durations as already expired', () => {
    const zero = decisionExpiry({ duration: '0s' }, answeredAt);
    const negative = decisionExpiry({ duration: '-1.5s' }, answeredAt);
    expect(expiryRemainingMs(zero, answeredAt)).toBe(0);
    expect(expiryRemainingMs(negative, answeredAt)).toBe(-1500);
    expect(formatRemainingPhrase(negative, answeredAt)).toBe('expired');
  });

  it('never expires without until and duration', () => {
    expect(decisionExpiry({}, answeredAt)).toEqual({ kind: 'never' });
    expect(decisionExpiry({ duration: '' }, answeredAt)).toEqual({ kind: 'never' });
    expect(decisionExpiry({ until: null, duration: null }, answeredAt)).toEqual({ kind: 'never' });
  });

  it('is unknown with an unreadable duration', () => {
    expect(decisionExpiry({ duration: '4d' }, answeredAt)).toEqual({ kind: 'unknown' });
  });

  it('sorts never/unknown after any date', () => {
    expect(expiryRemainingMs({ kind: 'never' }, answeredAt)).toBe(Number.POSITIVE_INFINITY);
    expect(expiryRemainingMs({ kind: 'unknown' }, answeredAt)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('formatRemaining', () => {
  it.each([
    [3 * H + 56 * M + 24 * S, '3h 56m'],
    [4 * H, '4h'],
    [26 * H + 5 * M, '1d 2h'],
    [48 * H + 59 * M, '2d'],
    [12 * M + 59 * S, '12m'],
    [45 * S + 999, '45s'],
    [999, '0s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected);
  });

  it('returns null for a time that is over', () => {
    expect(formatRemaining(0)).toBeNull();
    expect(formatRemaining(-5)).toBeNull();
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatExpiry', () => {
  const now = Date.parse('2026-11-11T19:08:00Z');
  const utc: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  };

  it('renders the date and the remaining time', () => {
    const expiry = decisionExpiry({ duration: '3h56m24s' }, now);
    expect(formatExpiry(expiry, now, 'en-GB', utc)).toBe('11 Nov 2026, 23:04 (in 3h 56m)');
  });

  it('marks a past date as expired', () => {
    const expiry = decisionExpiry({ until: '2026-11-11T19:00:00Z' }, now);
    expect(formatExpiry(expiry, now, 'en-GB', utc)).toBe('11 Nov 2026, 19:00 (expired)');
  });

  it('renders never and unknown without a date', () => {
    expect(formatExpiry({ kind: 'never' }, now)).toBe('never');
    expect(formatExpiry({ kind: 'unknown' }, now)).toBe('unknown');
    expect(formatExpiryDate({ kind: 'never' })).toBe('never');
    expect(formatRemainingPhrase({ kind: 'never' }, now)).toBeNull();
  });

  it('uses the browser locale by default', () => {
    const expiry = decisionExpiry({ duration: '1h' }, now);
    expect(formatExpiryDate(expiry)).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(now + H)
      )
    );
  });
});
