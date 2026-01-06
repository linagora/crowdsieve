import { describe, it, expect } from 'vitest';
import { ExpressionFilter } from '../src/filters/implementations/expression.js';
import type { FilterContext } from '../src/filters/types.js';

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
