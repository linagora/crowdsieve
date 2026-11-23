/**
 * Helpers of the Manual Ban form (dashboard/lib/banForm.ts): list of targets,
 * custom duration, fan-out and result summary.
 */
import { describe, it, expect } from 'vitest';
import {
  BAN_CONCURRENCY,
  MAX_BAN_TARGETS,
  banButtonLabel,
  banTargetsError,
  customDuration,
  isIpOrCidr,
  parseBanTargets,
  runWithConcurrency,
  summarizeBanAttempts,
  type BanAttempt,
} from '@/lib/banForm';
import { isValidBanDuration } from '../src/proxy/routes/api.js';

describe('isIpOrCidr', () => {
  it.each([
    '198.51.100.7',
    '0.0.0.0',
    '255.255.255.255',
    '198.51.100.0/30',
    '10.0.0.0/8',
    '0.0.0.0/0',
    '2001:db8::1',
    '::1',
    '::ffff:192.0.2.1',
    '2001:db8::/32',
    'fe80::/128',
  ])('accepts %s', (value) => {
    expect(isIpOrCidr(value)).toBe(true);
  });

  it.each([
    '300.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    'foo',
    '198.51.100.0/33',
    '198.51.100.0/',
    '198.51.100.0/24/1',
    '198.51.100.0/2a',
    '2001:db8::/129',
    '2001:db8:::1',
    '1::2::3',
    '[::1]',
    'example.com',
    'http://1.2.3.4',
  ])('rejects %s', (value) => {
    expect(isIpOrCidr(value)).toBe(false);
  });
});

describe('parseBanTargets', () => {
  it('splits on new lines, commas and spaces', () => {
    expect(parseBanTargets('198.51.100.242, 198.51.100.243\n198.51.100.0/30')).toEqual({
      valid: ['198.51.100.242', '198.51.100.243', '198.51.100.0/30'],
      invalid: [],
    });
    expect(parseBanTargets(' 1.1.1.1\t2.2.2.2 ;3.3.3.3 \r\n').valid).toEqual([
      '1.1.1.1',
      '2.2.2.2',
      '3.3.3.3',
    ]);
  });

  it('removes duplicates, case-insensitively', () => {
    expect(parseBanTargets('1.1.1.1 1.1.1.1\n2001:DB8::1, 2001:db8::1').valid).toEqual([
      '1.1.1.1',
      '2001:DB8::1',
    ]);
  });

  it('lists invalid values', () => {
    const targets = parseBanTargets('300.1.1.1, foo 1.1.1.1 foo');
    expect(targets).toEqual({ valid: ['1.1.1.1'], invalid: ['300.1.1.1', 'foo'] });
    expect(banTargetsError(targets)).toBe('2 invalid entries: 300.1.1.1, foo');
    expect(banTargetsError(parseBanTargets('300.1.1.1'))).toBe('1 invalid entry: 300.1.1.1');
  });

  it(`limits a submission to ${MAX_BAN_TARGETS} values`, () => {
    const ips = (n: number) => Array.from({ length: n }, (_, i) => `10.0.${i >> 8}.${i & 255}`);
    expect(banTargetsError(parseBanTargets(ips(MAX_BAN_TARGETS).join('\n')))).toBeNull();
    expect(banTargetsError(parseBanTargets(ips(MAX_BAN_TARGETS + 1).join('\n')))).toBe(
      'At most 100 IPs per ban'
    );
  });

  it('returns nothing for an empty field', () => {
    expect(parseBanTargets('  \n ,')).toEqual({ valid: [], invalid: [] });
    expect(banTargetsError(parseBanTargets(''))).toBeNull();
  });
});

describe('banButtonLabel', () => {
  it('names the action and the number of IPs', () => {
    expect(banButtonLabel('ban', 1)).toBe('Ban');
    expect(banButtonLabel('ban', 15)).toBe('Ban 15 IPs');
    expect(banButtonLabel('captcha', 1)).toBe('Apply captcha');
    expect(banButtonLabel('captcha', 15)).toBe('Apply captcha to 15 IPs');
  });
});

describe('customDuration', () => {
  it('converts minutes, hours and days (days in hours)', () => {
    expect(customDuration('90', 'minutes')).toEqual({ duration: '90m' });
    expect(customDuration('2', 'hours')).toEqual({ duration: '2h' });
    expect(customDuration('3', 'days')).toEqual({ duration: '72h' });
    expect(customDuration(' 365 ', 'days')).toEqual({ duration: '8760h' });
    expect(customDuration('1', 'minutes')).toEqual({ duration: '1m' });
  });

  it.each([
    ['0', 'hours'],
    ['0', 'minutes'],
    ['400', 'days'],
    ['366', 'days'],
    ['8761', 'hours'],
    ['525601', 'minutes'],
    ['-1', 'hours'],
    ['', 'hours'],
    ['99999999999999999999', 'minutes'],
  ] as const)('rejects %s %s', (amount, unit) => {
    expect(customDuration(amount, unit)).toEqual({
      error: 'Duration must be between 1 minute and 365 days',
    });
  });

  it('asks for a whole number', () => {
    expect(customDuration('1.5', 'hours')).toEqual({ error: 'Enter a whole number' });
    expect(customDuration('2h', 'hours')).toEqual({ error: 'Enter a whole number' });
  });

  it('only produces durations the proxy accepts', () => {
    for (const [amount, unit] of [
      ['1', 'minutes'],
      ['525600', 'minutes'],
      ['8760', 'hours'],
      ['365', 'days'],
    ] as const) {
      const result = customDuration(amount, unit);
      expect('duration' in result && isValidBanDuration(result.duration)).toBe(true);
    }
  });
});

describe('runWithConcurrency', () => {
  it(`keeps at most ${BAN_CONCURRENCY} calls in flight and preserves the order`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 17 }, (_, i) => i);
    const results = await runWithConcurrency(items, BAN_CONCURRENCY, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
      inFlight--;
      return i * 2;
    });
    expect(results).toEqual(items.map((i) => i * 2));
    expect(maxInFlight).toBe(BAN_CONCURRENCY);
  });

  it('handles an empty list', async () => {
    expect(await runWithConcurrency([], 5, async () => 1)).toEqual([]);
  });
});

describe('summarizeBanAttempts', () => {
  const ok = (target: string, server = 'lapi-qa', message = `${target} banned for 4h`) =>
    ({ target, server, success: true, message }) satisfies BanAttempt;
  const ko = (target: string, server = 'lapi-qa', message = 'LAPI returned error: 500') =>
    ({ target, server, success: false, message }) satisfies BanAttempt;

  it('reports the count of banned values on one server', () => {
    const summary = summarizeBanAttempts(
      [ok('198.51.100.242'), ok('198.51.100.243'), ok('198.51.100.0/30')],
      ['lapi-qa'],
      'ban'
    );
    expect(summary).toEqual({
      success: true,
      message: '3 banned on lapi-qa',
      failedTargets: [],
      failures: [],
    });
  });

  it('keeps the API message for a single value', () => {
    const summary = summarizeBanAttempts(
      [ok('198.51.100.240', 'lapi-qa', '198.51.100.240: captcha for 2h')],
      ['lapi-qa'],
      'captcha'
    );
    expect(summary.message).toBe('198.51.100.240: captcha for 2h');
  });

  it('names captcha results', () => {
    expect(
      summarizeBanAttempts([ok('1.1.1.1'), ok('2.2.2.2')], ['lapi-qa'], 'captcha').message
    ).toBe('Captcha applied to 2 IPs on lapi-qa');
  });

  it('counts a value as banned only when every server succeeded', () => {
    const summary = summarizeBanAttempts(
      [ok('1.1.1.1', 'a'), ok('1.1.1.1', 'b'), ok('2.2.2.2', 'a'), ko('2.2.2.2', 'b')],
      ['a', 'b'],
      'ban'
    );
    expect(summary).toEqual({
      success: false,
      message: '1 banned, 1 failed: 2.2.2.2 — b: LAPI returned error: 500',
      failedTargets: ['2.2.2.2'],
      failures: ['2.2.2.2 — b: LAPI returned error: 500'],
    });
    expect(
      summarizeBanAttempts([ok('1.1.1.1', 'a'), ok('1.1.1.1', 'b')], ['a', 'b'], 'ban').message
    ).toBe('1.1.1.1 banned on all 2 servers');
  });

  it('lists several failures and keeps them for a retry', () => {
    const attempts = [
      ...Array.from({ length: 13 }, (_, i) => ok(`10.0.0.${i}`)),
      ko('203.0.113.9'),
      ko('203.0.113.10', 'lapi-qa', 'LAPI returned error: 403'),
    ];
    const summary = summarizeBanAttempts(attempts, ['lapi-qa'], 'ban');
    expect(summary.success).toBe(false);
    expect(summary.message).toBe('13 banned, 2 failed');
    expect(summary.failedTargets).toEqual(['203.0.113.9', '203.0.113.10']);
    expect(summary.failures).toEqual([
      '203.0.113.9 — LAPI returned error: 500',
      '203.0.113.10 — LAPI returned error: 403',
    ]);
  });
});
