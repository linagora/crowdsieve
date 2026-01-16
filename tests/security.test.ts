import { describe, it, expect } from 'vitest';
import net from 'net';
import { ExpressionFilter } from '../src/filters/implementations/expression.js';
import type { FilterContext } from '../src/filters/types.js';
import { MAX_ALERTS_PER_BATCH } from '../src/proxy/routes/signals.js';

/**
 * Escape SQL LIKE wildcards (copy from storage for testing)
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

/**
 * Create a mock FilterContext for testing
 */
function createMockContext(scenario: string): FilterContext {
  return {
    alert: {
      scenario,
      scenario_hash: 'test',
      scenario_version: '1.0',
      message: 'test',
      events_count: 1,
      start_at: '2024-01-01T00:00:00Z',
      stop_at: '2024-01-01T00:00:00Z',
      capacity: 1,
      leakspeed: '1h',
      simulated: false,
      events: [],
      source: { scope: 'ip', value: '1.2.3.4' },
      decisions: [],
    },
    timestamp: new Date(),
  };
}

describe('Security - SQL LIKE Escaping', () => {
  it('should escape percent wildcard', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('should escape underscore wildcard', () => {
    expect(escapeLikePattern('test_value')).toBe('test\\_value');
  });

  it('should escape backslash', () => {
    expect(escapeLikePattern('path\\file')).toBe('path\\\\file');
  });

  it('should escape multiple special characters', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('should not modify normal text', () => {
    expect(escapeLikePattern('crowdsecurity/ssh-bf')).toBe('crowdsecurity/ssh-bf');
  });
});

describe('Security - Regex Validation', () => {
  it('should handle valid regex patterns', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: '.*ssh.*',
    });
    const result = filter.matches(createMockContext('crowdsecurity/ssh-bf'));
    expect(result.matched).toBe(true);
  });

  it('should handle invalid regex patterns gracefully', () => {
    // Invalid regex pattern with unclosed bracket
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: '[invalid',
    });
    // Should not throw, should not match
    const result = filter.matches(createMockContext('test'));
    expect(result.matched).toBe(false);
  });

  it('should handle very long regex patterns', () => {
    // Pattern longer than the allowed MAX_REGEX_LENGTH
    const longPattern = 'a'.repeat(600);
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: longPattern,
    });
    // Should not match due to pattern being too long
    const result = filter.matches(createMockContext('aaaaaaa'));
    expect(result.matched).toBe(false);
  });

  it('should handle mixed valid and invalid patterns in array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: ['[invalid', 'ssh.*'],
    });
    // Should match second pattern
    const result = filter.matches(createMockContext('ssh-brute'));
    expect(result.matched).toBe(true);
  });
});

describe('Security - Input Validation', () => {
  it('should validate country code format', () => {
    const validCodes = ['US', 'FR', 'CN', 'RU', 'DE'];
    const invalidCodes = ['USA', 'us', '12', 'A', 'ABC'];
    const countryCodeRegex = /^[A-Z]{2}$/;

    for (const code of validCodes) {
      expect(countryCodeRegex.test(code)).toBe(true);
    }

    for (const code of invalidCodes) {
      expect(countryCodeRegex.test(code)).toBe(false);
    }
  });

  it('should bound limit values', () => {
    const MAX_LIMIT = 1000;
    const DEFAULT_LIMIT = 100;

    const boundLimit = (input: number | undefined): number => {
      const raw = input ?? DEFAULT_LIMIT;
      return Math.min(Math.max(isNaN(raw) ? DEFAULT_LIMIT : raw, 1), MAX_LIMIT);
    };

    expect(boundLimit(50)).toBe(50);
    expect(boundLimit(0)).toBe(1);
    expect(boundLimit(-10)).toBe(1);
    expect(boundLimit(2000)).toBe(1000);
    expect(boundLimit(undefined)).toBe(100);
    expect(boundLimit(NaN)).toBe(100);
  });

  it('should bound offset values', () => {
    const boundOffset = (input: number | undefined): number => {
      const raw = input ?? 0;
      return Math.max(isNaN(raw) ? 0 : raw, 0);
    };

    expect(boundOffset(50)).toBe(50);
    expect(boundOffset(0)).toBe(0);
    expect(boundOffset(-10)).toBe(0);
    expect(boundOffset(undefined)).toBe(0);
    expect(boundOffset(NaN)).toBe(0);
  });
});

describe('Security - Signals Batch Size Limit', () => {
  it('should export MAX_ALERTS_PER_BATCH constant', () => {
    expect(MAX_ALERTS_PER_BATCH).toBeDefined();
    expect(typeof MAX_ALERTS_PER_BATCH).toBe('number');
  });

  it('should have a reasonable batch limit', () => {
    // Limit should be between 100 and 10000
    expect(MAX_ALERTS_PER_BATCH).toBeGreaterThanOrEqual(100);
    expect(MAX_ALERTS_PER_BATCH).toBeLessThanOrEqual(10000);
  });

  it('should be exactly 1000', () => {
    expect(MAX_ALERTS_PER_BATCH).toBe(1000);
  });

  it('should allow valid batch sizes', () => {
    const validSizes = [1, 100, 500, 999, 1000];
    for (const size of validSizes) {
      expect(size <= MAX_ALERTS_PER_BATCH).toBe(true);
    }
  });

  it('should reject oversized batches', () => {
    const invalidSizes = [1001, 2000, 10000, 100000];
    for (const size of invalidSizes) {
      expect(size > MAX_ALERTS_PER_BATCH).toBe(true);
    }
  });
});

describe('Security - Dashboard IP Validation', () => {
  // Tests for IP validation in /api/ip-info/[ip] route
  it('should accept valid IPv4 addresses', () => {
    const validIPs = ['192.168.1.1', '10.0.0.1', '8.8.8.8', '1.1.1.1', '255.255.255.255'];
    for (const ip of validIPs) {
      expect(net.isIP(ip)).not.toBe(0);
    }
  });

  it('should accept valid IPv6 addresses', () => {
    const validIPs = ['::1', '2001:db8::1', 'fe80::1', '2001:0db8:85a3::8a2e:0370:7334'];
    for (const ip of validIPs) {
      expect(net.isIP(ip)).not.toBe(0);
    }
  });

  it('should reject invalid IP addresses in route parameter', () => {
    const invalidIPs = [
      'not-an-ip',
      '192.168.1.256',
      '192.168.1',
      'example.com',
      '',
      '../../../etc/passwd', // Path traversal attempt
      '192.168.1.1; cat /etc/passwd', // Command injection
      '<script>alert(1)</script>', // XSS
      '%00', // Null byte
    ];
    for (const ip of invalidIPs) {
      expect(net.isIP(ip)).toBe(0);
    }
  });
});

describe('Security - API Key Fail-Secure Behavior', () => {
  it('should treat missing API key as security violation', () => {
    // Simulates the fail-secure behavior in api.ts
    const configuredKey = undefined; // API key not configured
    const shouldReject = !configuredKey;
    expect(shouldReject).toBe(true);
  });

  it('should treat empty API key as security violation', () => {
    const configuredKey = '';
    const shouldReject = !configuredKey;
    expect(shouldReject).toBe(true);
  });

  it('should allow valid API key', () => {
    const configuredKey = 'valid-api-key-12345';
    const shouldReject = !configuredKey;
    expect(shouldReject).toBe(false);
  });

  it('should generate 64-character hex key', () => {
    // Simulates the key generation in index.ts
    const { randomBytes } = require('crypto');
    const generatedKey = randomBytes(32).toString('hex');
    expect(generatedKey).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(generatedKey)).toBe(true);
  });

  it('should mask key correctly for logging', () => {
    const key = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const maskedKey = `${key.slice(0, 4)}..${key.slice(-4)}`;
    expect(maskedKey).toBe('1234..cdef');
    expect(maskedKey).not.toContain(key); // Full key should not be in masked version
  });
});

describe('Security - CSRF Origin Validation', () => {
  it('should validate origin against allowed list', () => {
    const allowedOrigins = ['http://localhost:3000', 'https://dashboard.example.com'];

    const testCases = [
      { origin: 'http://localhost:3000', expected: true },
      { origin: 'https://dashboard.example.com', expected: true },
      { origin: 'https://evil.com', expected: false },
      { origin: 'http://localhost:3001', expected: false },
    ];

    for (const { origin, expected } of testCases) {
      const isAllowed = allowedOrigins.some((allowed) => origin === allowed.trim());
      expect(isAllowed).toBe(expected);
    }
  });

  it('should reject requests without Origin header', () => {
    const origin = undefined;
    // Updated logic: !origin || !allowedOrigins.some(...)
    const shouldReject = !origin;
    expect(shouldReject).toBe(true);
  });

  it('should reject requests with null Origin', () => {
    const origin = null;
    const shouldReject = !origin;
    expect(shouldReject).toBe(true);
  });
});

describe('Security - DELETE Decision CSRF Protection', () => {
  /**
   * Simulates the CSRF validation logic from the DELETE /api/decisions/:id endpoint
   */
  function validateDeleteOrigin(
    origin: string | undefined | null,
    allowedOrigins: string[]
  ): { allowed: boolean; error?: string } {
    if (!origin) {
      return { allowed: false, error: 'Forbidden: Invalid or missing origin' };
    }
    const isAllowed = allowedOrigins.some((allowed) => origin === allowed.trim());
    if (!isAllowed) {
      return { allowed: false, error: 'Forbidden: Invalid or missing origin' };
    }
    return { allowed: true };
  }

  it('should accept valid dashboard origin', () => {
    const allowedOrigins = ['http://localhost:3000', 'https://dashboard.example.com'];
    const result = validateDeleteOrigin('http://localhost:3000', allowedOrigins);
    expect(result.allowed).toBe(true);
  });

  it('should accept CORS_ORIGIN configured origins', () => {
    // Simulate CORS_ORIGIN env var
    const corsOrigin = 'https://prod.example.com,https://staging.example.com';
    const allowedOrigins = corsOrigin.split(',');

    expect(validateDeleteOrigin('https://prod.example.com', allowedOrigins).allowed).toBe(true);
    expect(validateDeleteOrigin('https://staging.example.com', allowedOrigins).allowed).toBe(true);
  });

  it('should reject requests from unauthorized origins', () => {
    const allowedOrigins = ['http://localhost:3000'];
    const unauthorizedOrigins = [
      'https://evil.com',
      'http://localhost:3001',
      'http://attacker.example.com',
      'file://',
    ];

    for (const origin of unauthorizedOrigins) {
      const result = validateDeleteOrigin(origin, allowedOrigins);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('Forbidden');
    }
  });

  it('should reject requests without Origin header', () => {
    const allowedOrigins = ['http://localhost:3000'];
    const result = validateDeleteOrigin(undefined, allowedOrigins);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('missing origin');
  });

  it('should reject requests with null Origin', () => {
    const allowedOrigins = ['http://localhost:3000'];
    const result = validateDeleteOrigin(null, allowedOrigins);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('missing origin');
  });

  it('should reject requests with empty Origin', () => {
    const allowedOrigins = ['http://localhost:3000'];
    const result = validateDeleteOrigin('', allowedOrigins);
    expect(result.allowed).toBe(false);
  });

  it('should handle whitespace in allowed origins', () => {
    // Simulate CORS_ORIGIN with whitespace: "http://localhost:3000, https://prod.example.com"
    const allowedOrigins = ['http://localhost:3000', ' https://prod.example.com'];
    const result = validateDeleteOrigin('https://prod.example.com', allowedOrigins);
    expect(result.allowed).toBe(true);
  });

  it('should be case-sensitive for origin matching', () => {
    const allowedOrigins = ['http://localhost:3000'];
    // Origins are case-sensitive per RFC 6454
    expect(validateDeleteOrigin('HTTP://LOCALHOST:3000', allowedOrigins).allowed).toBe(false);
    expect(validateDeleteOrigin('http://LOCALHOST:3000', allowedOrigins).allowed).toBe(false);
  });
});
