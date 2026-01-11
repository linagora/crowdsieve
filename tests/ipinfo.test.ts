import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getIPInfo,
  reverseDnsLookup,
  parseWhoisResponse,
  detectRir,
} from '../src/ipinfo/index.js';

describe('IP Info Module', () => {
  describe('parseWhoisResponse', () => {
    it('should parse ARIN-style WHOIS response', () => {
      const response = `
NetRange:       8.0.0.0 - 8.255.255.255
CIDR:           8.0.0.0/8
NetName:        LVLT-ORG-8-8
NetHandle:      NET-8-0-0-0-1
NetType:        Direct Allocation
OrgName:        Level 3 Parent, LLC
OrgId:          LPL-141
Country:        US
OrgAbuseEmail:  abuse@level3.com
`;
      const result = parseWhoisResponse(response);

      expect(result.netRange).toBe('8.0.0.0 - 8.255.255.255');
      expect(result.cidr).toBe('8.0.0.0/8');
      expect(result.netName).toBe('LVLT-ORG-8-8');
      expect(result.organization).toBe('Level 3 Parent, LLC');
      expect(result.country).toBe('US');
      expect(result.abuse).toBe('abuse@level3.com');
    });

    it('should parse RIPE-style WHOIS response', () => {
      const response = `
inetnum:        193.0.0.0 - 193.0.7.255
netname:        RIPE-NCC
descr:          RIPE Network Coordination Centre
country:        NL
abuse-mailbox:  abuse@ripe.net
`;
      const result = parseWhoisResponse(response);

      expect(result.netRange).toBe('193.0.0.0 - 193.0.7.255');
      expect(result.netName).toBe('RIPE-NCC');
      expect(result.descr).toBe('RIPE Network Coordination Centre');
      expect(result.country).toBe('NL');
      expect(result.abuse).toBe('abuse@ripe.net');
    });

    it('should parse IPv6 WHOIS response', () => {
      const response = `
inet6num:       2001:4860::/32
netname:        GOOGLE-IPV6
country:        US
`;
      const result = parseWhoisResponse(response);

      expect(result.netRange).toBe('2001:4860::/32');
      expect(result.netName).toBe('GOOGLE-IPV6');
      expect(result.country).toBe('US');
    });

    it('should handle empty response', () => {
      const result = parseWhoisResponse('');
      expect(result).toEqual({});
    });

    it('should handle response with no recognized fields', () => {
      const response = `
% This is a comment
% Another comment line
`;
      const result = parseWhoisResponse(response);
      expect(result).toEqual({});
    });

    it('should take first value for single-value fields', () => {
      const response = `
country:        US
country:        DE
organization:   First Org
organization:   Second Org
`;
      const result = parseWhoisResponse(response);

      expect(result.country).toBe('US');
      expect(result.organization).toBe('First Org');
    });

    it('should uppercase country codes', () => {
      const response = `country:        de`;
      const result = parseWhoisResponse(response);
      expect(result.country).toBe('DE');
    });
  });

  describe('detectRir', () => {
    it('should detect ARIN from refer line', () => {
      const response = `refer:        whois.arin.net`;
      expect(detectRir(response)).toBe('ARIN');
    });

    it('should detect RIPE from refer line', () => {
      const response = `refer:        whois.ripe.net`;
      expect(detectRir(response)).toBe('RIPE');
    });

    it('should detect APNIC from refer line', () => {
      const response = `refer:        whois.apnic.net`;
      expect(detectRir(response)).toBe('APNIC');
    });

    it('should detect LACNIC from refer line', () => {
      const response = `refer:        whois.lacnic.net`;
      expect(detectRir(response)).toBe('LACNIC');
    });

    it('should detect AFRINIC from refer line', () => {
      const response = `refer:        whois.afrinic.net`;
      expect(detectRir(response)).toBe('AFRINIC');
    });

    it('should detect from whois: line', () => {
      const response = `whois:        whois.ripe.net`;
      expect(detectRir(response)).toBe('RIPE');
    });

    it('should handle extra whitespace', () => {
      const response = `refer:          whois.arin.net`;
      expect(detectRir(response)).toBe('ARIN');
    });

    it('should be case-insensitive', () => {
      const response = `REFER:        WHOIS.ARIN.NET`;
      expect(detectRir(response)).toBe('ARIN');
    });

    it('should return null for unknown servers', () => {
      const response = `refer:        whois.unknown.net`;
      expect(detectRir(response)).toBeNull();
    });

    it('should return null for empty response', () => {
      expect(detectRir('')).toBeNull();
    });

    it('should return null when no refer/whois line', () => {
      const response = `
inetnum:        193.0.0.0 - 193.0.7.255
netname:        RIPE-NCC
`;
      expect(detectRir(response)).toBeNull();
    });

    it('should not match partial hostnames (security)', () => {
      // This tests the security fix - substring matching should not work
      const response = `refer:        evil.whois.arin.net.attacker.com`;
      expect(detectRir(response)).toBeNull();
    });

    it('should not match embedded hostnames (security)', () => {
      const response = `refer:        prefix-whois.arin.net`;
      expect(detectRir(response)).toBeNull();
    });
  });

  describe('getIPInfo', () => {
    it('should return error for invalid IP address', async () => {
      const result = await getIPInfo('not-an-ip');

      expect(result.ip).toBe('not-an-ip');
      expect(result.error).toBe('Invalid IP address');
      expect(result.reverseDns).toEqual([]);
      expect(result.whois).toBeNull();
    });

    it('should return error for empty string', async () => {
      const result = await getIPInfo('');

      expect(result.error).toBe('Invalid IP address');
    });

    it('should accept valid IPv4 address', async () => {
      // Note: This will attempt real DNS/WHOIS lookups
      // We're just testing that it doesn't return an error for valid IPs
      const result = await getIPInfo('127.0.0.1');

      expect(result.ip).toBe('127.0.0.1');
      expect(result.error).toBeUndefined();
    });

    it('should accept valid IPv6 address', async () => {
      const result = await getIPInfo('::1');

      expect(result.ip).toBe('::1');
      expect(result.error).toBeUndefined();
    });
  });

  describe('reverseDnsLookup', () => {
    it('should return empty array for localhost', async () => {
      // Localhost typically has no reverse DNS
      const result = await reverseDnsLookup('127.0.0.1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return empty array for invalid IP', async () => {
      const result = await reverseDnsLookup('999.999.999.999');
      expect(result).toEqual([]);
    });
  });
});
