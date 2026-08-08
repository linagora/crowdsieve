import { describe, expect, it } from 'vitest';
import { cidrContains } from '../src/filters/cidr.js';

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

  it('should reject an invalid target IP', () => {
    expect(() => cidrContains('192.168.0.0/16', 'not-an-ip')).toThrow();
    expect(() => cidrContains('192.168.0.0/16', '')).toThrow();
    expect(() => cidrContains('192.168.0.0/16', '192.168.1')).toThrow();
  });
});
