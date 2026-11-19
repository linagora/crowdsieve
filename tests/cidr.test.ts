import { describe, expect, it } from 'vitest';
import { cidrContains, cidrMatches, parseCidr, parseIp } from '../src/filters/cidr.js';

describe('cidrContains - IPv4', () => {
  it('should match an address inside the range', () => {
    expect(cidrContains('192.168.0.0/16', '192.168.1.5')).toBe(true);
    expect(cidrContains('10.0.0.0/8', '10.255.255.255')).toBe(true);
  });

  it('should not match an address outside the range', () => {
    expect(cidrContains('10.0.0.0/8', '192.168.1.5')).toBe(false);
    expect(cidrContains('192.168.0.0/16', '192.169.0.1')).toBe(false);
  });

  it('should handle range boundaries exactly', () => {
    expect(cidrContains('192.168.1.0/24', '192.168.1.0')).toBe(true);
    expect(cidrContains('192.168.1.0/24', '192.168.1.255')).toBe(true);
    expect(cidrContains('192.168.1.0/24', '192.168.0.255')).toBe(false);
    expect(cidrContains('192.168.1.0/24', '192.168.2.0')).toBe(false);
  });

  it('should treat /32 as a host route', () => {
    expect(cidrContains('192.168.1.1/32', '192.168.1.1')).toBe(true);
    expect(cidrContains('192.168.1.1/32', '192.168.1.2')).toBe(false);
  });

  it('should treat /0 as matching every IPv4 address', () => {
    expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(cidrContains('0.0.0.0/0', '255.255.255.255')).toBe(true);
  });

  it('should ignore host bits set in the base address', () => {
    expect(cidrContains('192.168.1.77/24', '192.168.1.5')).toBe(true);
  });

  it('should accept a bare address as an implicit /32', () => {
    expect(cidrContains('192.168.1.1', '192.168.1.1')).toBe(true);
    expect(cidrContains('192.168.1.1', '192.168.1.2')).toBe(false);
  });

  it('should handle non-byte-aligned prefixes', () => {
    expect(cidrContains('192.168.1.0/25', '192.168.1.127')).toBe(true);
    expect(cidrContains('192.168.1.0/25', '192.168.1.128')).toBe(false);
    expect(cidrContains('203.0.113.64/26', '203.0.113.100')).toBe(true);
    expect(cidrContains('203.0.113.64/26', '203.0.113.128')).toBe(false);
  });
});

describe('cidrContains - IPv6', () => {
  it('should match an address inside the range', () => {
    expect(cidrContains('2001:db8::/32', '2001:db8:1234::1')).toBe(true);
    expect(cidrContains('fe80::/10', 'fe80::1')).toBe(true);
  });

  it('should not match an address outside the range', () => {
    expect(cidrContains('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(cidrContains('fe80::/10', '2001:db8::1')).toBe(false);
  });

  it('should handle full-length and zero-length prefixes', () => {
    expect(cidrContains('::1/128', '::1')).toBe(true);
    expect(cidrContains('::1/128', '::2')).toBe(false);
    expect(cidrContains('::/0', '2001:db8::1')).toBe(true);
  });

  it('should expand :: compression consistently', () => {
    expect(cidrContains('2001:db8:0:0:0:0:0:0/32', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
      true
    );
    expect(cidrContains('2001:db8::/64', '2001:db8::ffff:ffff:ffff:ffff')).toBe(true);
    expect(cidrContains('2001:db8::/64', '2001:db8:0:1::1')).toBe(false);
  });

  it('should handle embedded IPv4 notation', () => {
    expect(cidrContains('::ffff:192.168.0.0/112', '::ffff:192.168.1.1')).toBe(true);
    expect(cidrContains('::ffff:0:0/96', '::ffff:8.8.8.8')).toBe(true);
  });

  it('should ignore a zone index', () => {
    expect(cidrContains('fe80::/10', 'fe80::1%eth0')).toBe(true);
  });

  it('should handle non-nibble-aligned prefixes', () => {
    expect(cidrContains('2001:db8::/33', '2001:db8:7fff::1')).toBe(true);
    expect(cidrContains('2001:db8::/33', '2001:db8:8000::1')).toBe(false);
  });

  it('should handle prefixes inside the last 32-bit word', () => {
    expect(cidrContains('::ffff:0:0/96', '::ffff:128.0.0.1')).toBe(true);
    expect(cidrContains('::ffff:0:0/96', '::fffe:128.0.0.1')).toBe(false);
    expect(cidrContains('::ffff:0:0/100', '::ffff:fff:ffff')).toBe(true);
    expect(cidrContains('::ffff:0:0/100', '::ffff:1000:0')).toBe(false);
    expect(cidrContains('::1:0:0/127', '::1:0:1')).toBe(true);
    expect(cidrContains('::1:0:0/127', '::1:0:2')).toBe(false);
  });

  it('should expand :: when the moved groups overlap the gap', () => {
    expect(parseIp('1::3:4:5:6:7:8')).toEqual(parseIp('1:0:3:4:5:6:7:8'));
    expect(cidrContains('1::3:4:5:6:7:8/128', '1:0:3:4:5:6:7:8')).toBe(true);
  });
});

describe('cidrContains - address families do not cross', () => {
  it('should not match an IPv4 address against an IPv6 range', () => {
    expect(cidrContains('::/0', '192.168.1.1')).toBe(false);
    expect(cidrContains('::ffff:192.168.0.0/112', '192.168.1.1')).toBe(false);
  });

  it('should not match an IPv6 address against an IPv4 range', () => {
    expect(cidrContains('0.0.0.0/0', '::1')).toBe(false);
    expect(cidrContains('192.168.0.0/16', '::ffff:192.168.1.1')).toBe(false);
  });
});

// Each case below is a point where the previous `ip-cidr@4.0.2` implementation
// disagreed with this one. Expected values are cross-checked against Python's
// `ipaddress` module, which sides with this implementation in every case.
describe('cidrContains - divergences from the previous ip-cidr implementation', () => {
  it('should not let an IPv6 address match an IPv4 range (ip-cidr returned true)', () => {
    // ip-cidr compared raw integers with no family check, so ::1 (= 1) fell
    // inside 0.0.0.0/0 (= [0, 2^32-1]).
    expect(cidrContains('0.0.0.0/0', '::1')).toBe(false);
    expect(cidrContains('10.0.0.0/8', '::a00:1')).toBe(false);
    expect(cidrContains('192.168.0.0/16', '::ffff:192.168.1.1')).toBe(false);
  });

  it('should match ranges with an embedded IPv4 tail (ip-cidr returned false)', () => {
    expect(cidrContains('::ffff:0:0/96', '::ffff:8.8.8.8')).toBe(true);
    expect(cidrContains('::ffff:192.168.0.0/112', '::ffff:192.168.1.1')).toBe(true);
  });

  it('should accept inputs ip-cidr threw on', () => {
    expect(cidrContains('0:0:0:0:0:ffff:1.2.3.4/128', '::ffff:1.2.3.4')).toBe(true);
    expect(cidrContains('  192.168.1.0/24  ', '192.168.1.5')).toBe(true);
    expect(cidrContains('192.168.1.1', '192.168.1.1')).toBe(true);
  });

  it('should still return false overall for inputs ip-cidr silently rejected', () => {
    // These now throw and are caught by ExpressionFilter.isInCIDR, which logs a
    // warning and returns false — the same observable result as before.
    for (const bad of ['010.0.0.1', '0177.0.0.1', 'not-an-ip', '', '192.168.1']) {
      expect(() => cidrContains('10.0.0.0/8', bad)).toThrow();
    }
  });
});

describe('cidrContains - rejects ambiguous and malformed input', () => {
  // GHSA-mwp4-54f8-5fhr: leading-zero octets are octal to resolvers but were
  // decoded as decimal by ip-address, allowing a trust-boundary bypass.
  it('should reject leading-zero octets rather than decoding them as decimal', () => {
    expect(() => cidrContains('010.0.0.0/8', '10.0.0.1')).toThrow();
    expect(() => cidrContains('10.0.0.0/8', '010.0.0.1')).toThrow();
    expect(() => cidrContains('127.0.0.0/8', '0177.0.0.1')).toThrow();
  });

  it('should reject malformed CIDR ranges', () => {
    expect(() => cidrContains('not-an-ip/24', '192.168.1.1')).toThrow();
    expect(() => cidrContains('192.168.1.0/24/8', '192.168.1.1')).toThrow();
    expect(() => cidrContains('256.0.0.0/8', '192.168.1.1')).toThrow();
    expect(() => cidrContains('192.168.1.0/', '192.168.1.1')).toThrow();
  });

  it('should reject out-of-range and non-numeric prefix lengths', () => {
    expect(() => cidrContains('192.168.1.0/33', '192.168.1.1')).toThrow();
    expect(() => cidrContains('2001:db8::/129', '2001:db8::1')).toThrow();
    expect(() => cidrContains('192.168.1.0/8abc', '192.168.1.1')).toThrow();
    expect(() => cidrContains('192.168.1.0/0x10', '192.168.1.1')).toThrow();
    expect(() => cidrContains('192.168.1.0/-1', '192.168.1.1')).toThrow();
    expect(() => cidrContains('192.168.1.0/024', '192.168.1.5')).toThrow();
  });

  it('should reject groups that are not hexadecimal rather than decoding a prefix', () => {
    // parseInt("0gg0", 16) is 0, so a malformed group used to be accepted.
    expect(() => cidrContains('2001:db8:0gg0::/64', '2001:db8::1')).toThrow();
    expect(() => cidrContains('2001:db8::/64', '2001:db8:0gg0::1')).toThrow();
    expect(() => cidrContains('::/0', '0gg0::')).toThrow();
    expect(() => cidrContains('::/0', '::1%eth0')).not.toThrow();
  });

  it('should reject an invalid target IP', () => {
    expect(() => cidrContains('192.168.0.0/16', 'not-an-ip')).toThrow();
    expect(() => cidrContains('192.168.0.0/16', '')).toThrow();
    expect(() => cidrContains('192.168.0.0/16', '192.168.1')).toThrow();
  });
});

describe('parseIp', () => {
  it('should parse both families into 32-bit words', () => {
    expect(parseIp('192.168.1.5')).toEqual({ bits: 32, w0: 0xc0a80105, w1: 0, w2: 0, w3: 0 });
    expect(parseIp('255.255.255.255')).toEqual({ bits: 32, w0: 0xffffffff, w1: 0, w2: 0, w3: 0 });
    expect(parseIp('2001:DB8::ffff:1')).toEqual({
      bits: 128,
      w0: 0x20010db8,
      w1: 0,
      w2: 0,
      w3: 0xffff0001,
    });
  });

  it('should expand embedded IPv4, strip the zone index and keep mapped addresses IPv6', () => {
    expect(parseIp('::ffff:192.168.1.1')).toEqual({
      bits: 128,
      w0: 0,
      w1: 0,
      w2: 0xffff,
      w3: 0xc0a80101,
    });
    expect(parseIp('0:0:0:0:0:ffff:192.168.1.1')).toEqual(parseIp('::ffff:c0a8:101'));
    expect(parseIp('fe80::1%eth0')).toEqual(parseIp('fe80::1'));
  });

  it('should return null for invalid or ambiguous addresses', () => {
    for (const bad of [
      '',
      'not-an-ip',
      '192.168.1',
      '256.0.0.1',
      '010.0.0.1',
      '0177.0.0.1',
      ' 10.0.0.1',
      '10.0.0.1 ',
      '10.0.0.0/8',
      '0gg0::',
      '2001:db8:0gg0::1',
      '1::2::3',
      '1:2:3:4:5:6:7',
      '12345::',
      '::ffff:010.0.0.1',
    ]) {
      expect(parseIp(bad)).toBeNull();
    }
  });
});

describe('non-string input', () => {
  it('should not coerce objects with a toString method', () => {
    const fake = { toString: () => '1.2.3.4' } as unknown as string;
    expect(parseIp(fake)).toBeNull();
    expect(() => cidrContains('1.2.3.4/32', fake)).toThrow('Invalid IP address');
    expect(() => parseCidr(fake)).toThrow('Invalid CIDR notation');
    expect(() => cidrContains(fake, '1.2.3.4')).toThrow('Invalid CIDR notation');
  });
});

describe('parseCidr', () => {
  it('should store the base with its host bits cleared', () => {
    expect(parseCidr('192.168.1.77/24')).toMatchObject({
      bits: 32,
      prefix: 24,
      w0: 0xc0a80100,
      m0: 0xffffff00,
    });
    expect(parseCidr('2001:db8:ffff::/33')).toMatchObject({
      bits: 128,
      prefix: 33,
      w0: 0x20010db8,
      w1: 0x80000000,
      m1: 0x80000000,
      m2: 0,
    });
  });

  it('should trim whitespace and treat a bare address as a host route', () => {
    expect(parseCidr('  10.0.0.1  ')).toMatchObject({ bits: 32, prefix: 32 });
    expect(parseCidr('::1')).toMatchObject({ bits: 128, prefix: 128, w3: 1, m3: 0xffffffff });
  });

  it('should throw the same messages as cidrContains', () => {
    expect(() => parseCidr('not-an-ip/24')).toThrow('Invalid CIDR notation: "not-an-ip/24"');
    expect(() => parseCidr('192.168.1.0/24/8')).toThrow(
      'Invalid CIDR notation: "192.168.1.0/24/8"'
    );
    expect(() => parseCidr('010.0.0.0/8')).toThrow('Invalid CIDR notation: "010.0.0.0/8"');
    expect(() => parseCidr('2001:db8:0gg0::/64')).toThrow('Invalid CIDR notation');
    expect(() => parseCidr('192.168.1.0/')).toThrow('Invalid CIDR prefix length: "192.168.1.0/"');
    expect(() => parseCidr('192.168.1.0/33')).toThrow('Invalid CIDR prefix length');
    expect(() => parseCidr('2001:db8::/129')).toThrow('Invalid CIDR prefix length');
    expect(() => parseCidr('192.168.1.0/024')).toThrow('Invalid CIDR prefix length');
    expect(() => parseCidr('192.168.1.0/0x10')).toThrow('Invalid CIDR prefix length');
    expect(() => cidrContains('10.0.0.0/8', 'nope')).toThrow('Invalid IP address: "nope"');
  });
});

describe('cidrMatches', () => {
  const ip = (s: string) => {
    const parsed = parseIp(s);
    if (parsed === null) throw new Error(`bad test address ${s}`);
    return parsed;
  };

  it('should match /0 against every address of the same family only', () => {
    expect(cidrMatches(parseCidr('0.0.0.0/0'), ip('255.255.255.255'))).toBe(true);
    expect(cidrMatches(parseCidr('::/0'), ip('ffff::1'))).toBe(true);
    expect(cidrMatches(parseCidr('0.0.0.0/0'), ip('::'))).toBe(false);
    expect(cidrMatches(parseCidr('::/0'), ip('0.0.0.0'))).toBe(false);
  });

  it('should never cross families, even with identical numeric values', () => {
    expect(cidrMatches(parseCidr('10.0.0.0/8'), ip('a00::'))).toBe(false);
    expect(cidrMatches(parseCidr('::ffff:192.168.0.0/112'), ip('192.168.1.1'))).toBe(false);
    expect(cidrMatches(parseCidr('192.168.0.0/16'), ip('::ffff:192.168.1.1'))).toBe(false);
  });

  it('should compare every word under the prefix mask', () => {
    const range = parseCidr('2001:db8:0:0:8000::/65');
    expect(cidrMatches(range, ip('2001:db8::8000:0:0:1'))).toBe(true);
    expect(cidrMatches(range, ip('2001:db8::7fff:0:0:1'))).toBe(false);
    expect(cidrMatches(parseCidr('::1/128'), ip('::1'))).toBe(true);
    expect(cidrMatches(parseCidr('::1/128'), ip('::2'))).toBe(false);
    expect(cidrMatches(parseCidr('128.0.0.0/1'), ip('255.0.0.1'))).toBe(true);
    expect(cidrMatches(parseCidr('128.0.0.0/1'), ip('127.255.255.255'))).toBe(false);
  });
});
