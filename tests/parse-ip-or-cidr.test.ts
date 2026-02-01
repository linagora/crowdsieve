import { describe, it, expect } from 'vitest';
import { parseIpOrCidr } from '../src/proxy/routes/api.js';

describe('parseIpOrCidr', () => {
  describe('valid single IPs', () => {
    it('should parse IPv4 address', () => {
      const result = parseIpOrCidr('1.2.3.4');
      expect(result).toEqual({ valid: true, scope: 'ip', value: '1.2.3.4' });
    });

    it('should parse IPv6 address', () => {
      const result = parseIpOrCidr('2001:db8::1');
      expect(result).toEqual({ valid: true, scope: 'ip', value: '2001:db8::1' });
    });

    it('should parse IPv4 with whitespace', () => {
      const result = parseIpOrCidr('  10.0.0.1  ');
      expect(result).toEqual({ valid: true, scope: 'ip', value: '10.0.0.1' });
    });
  });

  describe('valid CIDR', () => {
    it('should parse IPv4 CIDR with whitespace', () => {
      const result = parseIpOrCidr('  192.168.1.0/24  ');
      expect(result).toEqual({ valid: true, scope: 'range', value: '192.168.1.0/24' });
    });

    it('should parse IPv6 CIDR with whitespace', () => {
      const result = parseIpOrCidr('  2001:db8::/32  ');
      expect(result).toEqual({ valid: true, scope: 'range', value: '2001:db8::/32' });
    });

    it('should parse IPv4 CIDR', () => {
      const result = parseIpOrCidr('192.168.1.0/24');
      expect(result).toEqual({ valid: true, scope: 'range', value: '192.168.1.0/24' });
    });

    it('should parse IPv4 /32', () => {
      const result = parseIpOrCidr('10.0.0.1/32');
      expect(result).toEqual({ valid: true, scope: 'range', value: '10.0.0.1/32' });
    });

    it('should parse IPv4 /0', () => {
      const result = parseIpOrCidr('0.0.0.0/0');
      expect(result).toEqual({ valid: true, scope: 'range', value: '0.0.0.0/0' });
    });

    it('should parse IPv6 CIDR', () => {
      const result = parseIpOrCidr('2001:db8::/32');
      expect(result).toEqual({ valid: true, scope: 'range', value: '2001:db8::/32' });
    });

    it('should parse IPv6 /128', () => {
      const result = parseIpOrCidr('::1/128');
      expect(result).toEqual({ valid: true, scope: 'range', value: '::1/128' });
    });
  });

  describe('invalid inputs', () => {
    it('should reject empty string', () => {
      const result = parseIpOrCidr('');
      expect(result).toEqual({ valid: false });
    });

    it('should reject random text', () => {
      const result = parseIpOrCidr('hello');
      expect(result).toEqual({ valid: false });
    });

    it('should reject invalid IPv4', () => {
      const result = parseIpOrCidr('999.999.999.999');
      expect(result).toEqual({ valid: false });
    });

    it('should reject IPv4 CIDR prefix too large', () => {
      const result = parseIpOrCidr('1.2.3.4/33');
      expect(result).toEqual({ valid: false });
    });

    it('should reject IPv6 CIDR prefix too large', () => {
      const result = parseIpOrCidr('::1/129');
      expect(result).toEqual({ valid: false });
    });

    it('should reject negative prefix', () => {
      const result = parseIpOrCidr('1.2.3.4/-1');
      expect(result).toEqual({ valid: false });
    });

    it('should reject non-numeric prefix', () => {
      const result = parseIpOrCidr('1.2.3.4/abc');
      expect(result).toEqual({ valid: false });
    });

    it('should reject double slash', () => {
      const result = parseIpOrCidr('1.2.3.4/24/8');
      expect(result).toEqual({ valid: false });
    });

    it('should reject just a slash', () => {
      const result = parseIpOrCidr('/');
      expect(result).toEqual({ valid: false });
    });

    it('should reject IP with trailing slash', () => {
      const result = parseIpOrCidr('1.2.3.4/');
      expect(result).toEqual({ valid: false });
    });
  });
});
