import { describe, expect, it } from 'vitest';
import { alertMatchesIpSearch, parseIpSearch, type IpSearch } from '../dashboard/lib/ipSearch.js';
import { parseIpOrCidr } from '../src/proxy/routes/api.js';
import { parseCidr } from '../src/filters/cidr.js';

function search(value: string): IpSearch {
  const parsed = parseIpSearch(value);
  if (!parsed) throw new Error(`invalid test value ${value}`);
  return parsed;
}

describe('parseIpSearch', () => {
  it('accepts IPv4 and IPv6 addresses, trimmed and lower-cased', () => {
    expect(parseIpSearch('203.0.113.7')).toMatchObject({
      value: '203.0.113.7',
      isRange: false,
      bits: 32,
      prefix: 32,
    });
    expect(parseIpSearch('  2001:DB8::1 ')).toMatchObject({
      value: '2001:db8::1',
      isRange: false,
      bits: 128,
    });
    expect(parseIpSearch('::ffff:192.0.2.1')).toMatchObject({ bits: 128 });
    expect(parseIpSearch('::')).toMatchObject({ bits: 128 });
  });

  it('accepts CIDR ranges', () => {
    expect(parseIpSearch('203.0.113.0/24')).toMatchObject({ isRange: true, prefix: 24 });
    expect(parseIpSearch('2001:db8::/32')).toMatchObject({ isRange: true, prefix: 32 });
    expect(parseIpSearch('0.0.0.0/0')).toMatchObject({ isRange: true, prefix: 0 });
  });

  it('rejects anything else', () => {
    for (const value of [
      '',
      '   ',
      'not-an-ip',
      '203.0.113',
      '203.0.113.256',
      '010.0.0.1',
      '203.0.113.0/33',
      '203.0.113.0/24abc',
      '203.0.113.0/024',
      '203.0.113.0/',
      '203.0.113.0/24/8',
      '2001:db8::/129',
      '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
      '[::1]',
      '::1]@example.com',
      'example.com',
    ]) {
      expect(parseIpSearch(value), value).toBeNull();
    }
    expect(parseIpSearch(null)).toBeNull();
  });

  it('only accepts values the proxy accepts too', () => {
    for (const value of [
      '203.0.113.7',
      '203.0.113.0/24',
      '2001:db8::1',
      '2001:db8::/32',
      '::ffff:192.0.2.1',
      '1::',
      '2001:db8:0:0:0:0:0:1/128',
    ]) {
      const parsed = parseIpSearch(value);
      expect(parsed, value).not.toBeNull();
      expect(parseIpOrCidr(parsed!.value).valid, value).toBe(true);
      if (parsed!.isRange) expect(() => parseCidr(parsed!.value), value).not.toThrow();
    }
  });
});

describe('alertMatchesIpSearch', () => {
  it('matches a single address exactly on the source IP or value', () => {
    const s = search('203.0.113.7');
    expect(alertMatchesIpSearch(s, { sourceIp: '203.0.113.7' })).toBe(true);
    expect(alertMatchesIpSearch(s, { sourceValue: '203.0.113.7' })).toBe(true);
    expect(alertMatchesIpSearch(s, { sourceIp: '203.0.113.70' })).toBe(false);
    expect(alertMatchesIpSearch(search('2001:db8::1'), { sourceIp: '2001:DB8::1' })).toBe(true);
  });

  it('matches addresses and ranges inside a searched IPv4 range', () => {
    const s = search('203.0.112.0/20');
    expect(alertMatchesIpSearch(s, { sourceIp: '203.0.127.254' })).toBe(true);
    expect(alertMatchesIpSearch(s, { sourceIp: '203.0.128.1' })).toBe(false);
    expect(alertMatchesIpSearch(s, { sourceRange: '203.0.113.0/24' })).toBe(true);
    expect(alertMatchesIpSearch(s, { sourceValue: '203.0.0.0/16' })).toBe(false);
    expect(alertMatchesIpSearch(s, { sourceValue: 'FR' })).toBe(false);
  });

  it('matches IPv6 ranges whatever the textual form, without crossing families', () => {
    const s = search('2001:db8::/32');
    expect(alertMatchesIpSearch(s, { sourceIp: '2001:0db8:0000::5' })).toBe(true);
    expect(alertMatchesIpSearch(s, { sourceIp: '2001:db9::1' })).toBe(false);
    expect(alertMatchesIpSearch(search('0.0.0.0/0'), { sourceIp: '2001:db8::1' })).toBe(false);
    expect(alertMatchesIpSearch(search('2001:db8:8000::/33'), { sourceIp: '2001:db8::1' })).toBe(
      false
    );
    expect(
      alertMatchesIpSearch(search('2001:db8:8000::/33'), { sourceIp: '2001:db8:ffff::1' })
    ).toBe(true);
  });
});
