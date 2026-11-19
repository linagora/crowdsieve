import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExpressionFilter } from '../src/filters/implementations/expression.js';
import type { Alert } from '../src/models/alert.js';

function createMockAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    scenario: 'crowdsecurity/ssh-bf',
    scenario_hash: 'abc123',
    scenario_version: '1.0',
    message: 'SSH brute force',
    events_count: 5,
    start_at: '2024-01-01T00:00:00Z',
    stop_at: '2024-01-01T00:05:00Z',
    capacity: 5,
    leakspeed: '1h',
    simulated: false,
    events: [],
    source: {
      scope: 'ip',
      value: '192.168.1.100',
      ip: '192.168.1.100',
    },
    decisions: [],
    ...overrides,
  };
}

describe('ExpressionFilter - eq operator', () => {
  it('should match equal boolean value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'simulated',
      op: 'eq',
      value: true,
    });
    const alert = createMockAlert({ simulated: true });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match non-equal boolean value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'simulated',
      op: 'eq',
      value: true,
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match equal string value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'eq',
      value: 'crowdsecurity/ssh-bf',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - ne operator', () => {
  it('should match non-equal value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'simulated',
      op: 'ne',
      value: true,
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - numeric operators', () => {
  it('should match gt', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'events_count',
      op: 'gt',
      value: 3,
    });
    const alert = createMockAlert({ events_count: 5 });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match gte', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'events_count',
      op: 'gte',
      value: 5,
    });
    const alert = createMockAlert({ events_count: 5 });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match lt', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'events_count',
      op: 'lt',
      value: 10,
    });
    const alert = createMockAlert({ events_count: 5 });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match lte', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'events_count',
      op: 'lte',
      value: 5,
    });
    const alert = createMockAlert({ events_count: 5 });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - in/not_in operators', () => {
  it('should match value in array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'in',
      value: ['crowdsecurity/ssh-bf', 'crowdsecurity/http-bf'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match value not in array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'in',
      value: ['crowdsecurity/http-bf', 'crowdsecurity/ftp-bf'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match value not_in array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'not_in',
      value: ['crowdsecurity/http-bf', 'crowdsecurity/ftp-bf'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - empty/not_empty operators', () => {
  it('should match empty array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'decisions',
      op: 'empty',
    });
    const alert = createMockAlert({ decisions: [] });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match non-empty array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'decisions',
      op: 'empty',
    });
    const alert = createMockAlert({
      decisions: [
        {
          origin: 'crowdsec',
          type: 'ban',
          scope: 'ip',
          value: '1.2.3.4',
          duration: '4h',
          scenario: 'test',
        },
      ],
    });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match not_empty array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'decisions',
      op: 'not_empty',
    });
    const alert = createMockAlert({
      decisions: [
        {
          origin: 'crowdsec',
          type: 'ban',
          scope: 'ip',
          value: '1.2.3.4',
          duration: '4h',
          scenario: 'test',
        },
      ],
    });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - string operators', () => {
  it('should match contains', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'contains',
      value: 'ssh',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match starts_with', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'starts_with',
      value: 'crowdsecurity/',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match ends_with', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'ends_with',
      value: '-bf',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - glob operator', () => {
  it('should match glob pattern', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'glob',
      value: 'crowdsecurity/*',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match glob pattern array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'glob',
      value: ['crowdsecurity/http-*', 'crowdsecurity/ssh-*'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - regex operator', () => {
  it('should match regex pattern', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: '.*ssh.*',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match regex pattern array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: ['.*http.*', '.*ssh.*'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - cidr operator', () => {
  it('should match IP in CIDR range', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.ip',
      op: 'cidr',
      value: '192.168.0.0/16',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match IP in CIDR array', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.ip',
      op: 'cidr',
      value: ['10.0.0.0/8', '192.168.0.0/16'],
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match IP not in CIDR', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.ip',
      op: 'cidr',
      value: '10.0.0.0/8',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });
});

describe('ExpressionFilter - nested field access', () => {
  it('should access nested field', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.ip',
      op: 'eq',
      value: '192.168.1.100',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should access deeply nested field', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.scope',
      op: 'eq',
      value: 'ip',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match source.cn field', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.cn',
      op: 'in',
      value: ['CN', 'RU'],
    });
    const alert = createMockAlert({
      source: { scope: 'ip', value: '1.2.3.4', cn: 'CN' },
    });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - logical operators', () => {
  it('should match AND conditions', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'and',
      conditions: [
        { field: 'simulated', op: 'eq', value: false },
        { field: 'scenario', op: 'contains', value: 'ssh' },
      ],
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match AND when one condition fails', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'and',
      conditions: [
        { field: 'simulated', op: 'eq', value: true },
        { field: 'scenario', op: 'contains', value: 'ssh' },
      ],
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match OR when one condition matches', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'or',
      conditions: [
        { field: 'simulated', op: 'eq', value: true },
        { field: 'scenario', op: 'contains', value: 'ssh' },
      ],
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match OR when no condition matches', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'or',
      conditions: [
        { field: 'simulated', op: 'eq', value: true },
        { field: 'scenario', op: 'contains', value: 'http' },
      ],
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match NOT operator', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'not',
      condition: { field: 'simulated', op: 'eq', value: true },
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should handle nested logical operators', () => {
    const filter = new ExpressionFilter('test', true, {
      op: 'and',
      conditions: [
        { field: 'simulated', op: 'eq', value: false },
        {
          op: 'or',
          conditions: [
            { field: 'scenario', op: 'contains', value: 'ssh' },
            { field: 'scenario', op: 'contains', value: 'http' },
          ],
        },
      ],
    });
    const alert = createMockAlert({ simulated: false });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - FilterEngine integration', () => {
  it('should work with FilterEngine', async () => {
    const { FilterEngine } = await import('../src/filters/index.js');

    const engine = new FilterEngine('block', [
      {
        name: 'simulated-filter',
        enabled: true,
        filter: { field: 'simulated', op: 'eq', value: true },
      },
    ]);

    const alerts = [createMockAlert({ simulated: true }), createMockAlert({ simulated: false })];

    const result = engine.process(alerts);

    expect(result.originalCount).toBe(2);
    expect(result.filteredCount).toBe(1);
    expect(result.passedCount).toBe(1);
  });
});

describe('ExpressionFilter - not_contains operator', () => {
  it('should match string not containing value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'not_contains',
      value: 'http',
    });
    const alert = createMockAlert({ scenario: 'crowdsecurity/ssh-bf' });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match string containing value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'not_contains',
      value: 'ssh',
    });
    const alert = createMockAlert({ scenario: 'crowdsecurity/ssh-bf' });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match array not containing value', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'events',
      op: 'not_contains',
      value: 'test-event',
    });
    const alert = createMockAlert({ events: [] });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - undefined and null handling', () => {
  it('should match undefined field with empty operator', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'nonexistent_field',
      op: 'empty',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should not match undefined field with not_empty operator', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'nonexistent_field',
      op: 'not_empty',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should not match undefined field with eq operator', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'nonexistent_field',
      op: 'eq',
      value: 'some-value',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(false);
  });

  it('should match undefined field with ne operator', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'nonexistent_field',
      op: 'ne',
      value: 'some-value',
    });
    const alert = createMockAlert();
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });

  it('should match null source.cn with empty operator', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.cn',
      op: 'empty',
    });
    const alert = createMockAlert({
      source: { scope: 'ip', value: '1.2.3.4' },
    });
    const result = filter.matches({ alert, timestamp: new Date() });
    expect(result.matched).toBe(true);
  });
});

describe('ExpressionFilter - precompiled conditions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withIp(ip: unknown): Alert {
    return createMockAlert({ source: { scope: 'ip', value: String(ip), ip } as never });
  }

  it('warns about an invalid CIDR range once, naming the filter and the range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filter = new ExpressionFilter('internal', true, {
      field: 'source.ip',
      op: 'cidr',
      value: ['not-a-range', '192.168.0.0/16'],
    });
    // Reported by the constructor, before any alert is seen.
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) {
      const result = filter.matches({ alert: withIp(`192.168.1.${i}`), timestamp: new Date() });
      expect(result).toEqual({
        matched: true,
        filterName: 'internal',
        reason: 'source.ip in CIDR 192.168.0.0/16',
      });
      expect(filter.matches({ alert: withIp('8.8.8.8'), timestamp: new Date() }).matched).toBe(
        false
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"internal"');
    expect(warn.mock.calls[0][0]).toContain('"not-a-range"');
  });

  it('warns at construction about an invalid range nested under not/or', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filter = new ExpressionFilter('nested', true, {
      op: 'not',
      condition: {
        op: 'or',
        conditions: [
          { field: 'scenario', op: 'eq', value: 'custom/none' },
          { field: 'source.ip', op: 'cidr', value: ['10.0.0.0/8', '10.0.0.0/33'] },
        ],
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"nested"');
    expect(warn.mock.calls[0][0]).toContain('"10.0.0.0/33"');
    for (let i = 0; i < 10; i++) {
      expect(filter.matches({ alert: withIp('10.1.2.3'), timestamp: new Date() }).matched).toBe(
        false
      );
      expect(filter.matches({ alert: withIp('8.8.8.8'), timestamp: new Date() }).matched).toBe(
        true
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns at construction for a disabled rule and a branch never evaluated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new ExpressionFilter('disabled', false, {
      field: 'source.ip',
      op: 'cidr',
      value: 'bad-range',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"disabled"');

    const filter = new ExpressionFilter('unreached', true, {
      op: 'and',
      conditions: [
        { field: 'scenario', op: 'eq', value: 'custom/none' },
        { field: 'source.ip', op: 'cidr', value: '1.2.3.4/99' },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('"1.2.3.4/99"');
    // The and short-circuits on the first condition, so the cidr one is never
    // evaluated: it was only ever reported by the constructor.
    expect(filter.matches({ alert: withIp('1.2.3.4'), timestamp: new Date() }).matched).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives no match and no warning for an alert value that is not an IP', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filter = new ExpressionFilter('internal', true, {
      field: 'source.ip',
      op: 'cidr',
      value: ['10.0.0.0/8', '0.0.0.0/0', '::/0'],
    });
    for (const ip of ['not-an-ip', '010.0.0.1', '10.0.0', '', ' 10.0.0.1', 42, null]) {
      expect(filter.matches({ alert: withIp(ip), timestamp: new Date() }).matched).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the first matching range and quotes it as written', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'source.ip',
      op: 'cidr',
      value: ['2001:db8::/32', ' 10.0.0.0/8 ', '10.1.0.0/16', '::ffff:0:0/96'],
    });
    const v4 = filter.matches({ alert: withIp('10.1.2.3'), timestamp: new Date() });
    expect(v4.reason).toBe('source.ip in CIDR  10.0.0.0/8 ');
    const v6 = filter.matches({ alert: withIp('2001:db8::1'), timestamp: new Date() });
    expect(v6.reason).toBe('source.ip in CIDR 2001:db8::/32');
    const mapped = filter.matches({ alert: withIp('::ffff:10.1.2.3'), timestamp: new Date() });
    expect(mapped.reason).toBe('source.ip in CIDR ::ffff:0:0/96');
  });

  it('reuses compiled regexes with the same results and reasons', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'regex',
      value: ['[invalid', 'a'.repeat(501), 42 as never, '-bf$', 'ssh'],
    });
    for (let i = 0; i < 20; i++) {
      const hit = filter.matches({ alert: createMockAlert(), timestamp: new Date() });
      expect(hit.reason).toBe('scenario matches regex "-bf$"');
      const miss = filter.matches({
        alert: createMockAlert({ scenario: 'crowdsecurity/http-probing' }),
        timestamp: new Date(),
      });
      expect(miss.matched).toBe(false);
    }
  });

  it('reuses compiled globs with the same results and reasons', () => {
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'glob',
      value: ['#crowdsecurity/*', 'crowdsecurity/http-*', 'crowdsecurity/*', 'crowdsecurity/ssh-*'],
    });
    for (let i = 0; i < 20; i++) {
      const hit = filter.matches({ alert: createMockAlert(), timestamp: new Date() });
      expect(hit.reason).toBe('scenario matches glob "crowdsecurity/*"');
      const miss = filter.matches({
        alert: createMockAlert({ scenario: 'custom/ssh-bf' }),
        timestamp: new Date(),
      });
      expect(miss.matched).toBe(false);
    }

    const negated = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'glob',
      value: '!crowdsecurity/*',
    });
    const alert = createMockAlert({ scenario: 'custom/ssh-bf' });
    expect(negated.matches({ alert, timestamp: new Date() }).reason).toBe(
      'scenario matches glob "!crowdsecurity/*"'
    );
  });

  it('still throws at evaluation, not construction, for a glob minimatch refuses', () => {
    const tooLong = 'a'.repeat(70000);
    const filter = new ExpressionFilter('test', true, {
      field: 'scenario',
      op: 'glob',
      value: ['crowdsecurity/*', tooLong],
    });
    // An earlier match short-circuits before the refused pattern...
    expect(filter.matches({ alert: createMockAlert(), timestamp: new Date() }).matched).toBe(true);
    // ...otherwise minimatch() throws, as it did, and FilterEngine skips the rule.
    const other = createMockAlert({ scenario: 'custom/ssh-bf' });
    expect(() => filter.matches({ alert: other, timestamp: new Date() })).toThrow(
      'pattern is too long'
    );
  });

  it('does not keep a glob minimatch would not cache, and still matches it', () => {
    // 1024 expansions of ~30 characters: well over minimatch's per-entry
    // cache weight (4096), while staying fast to compile.
    const heavy = 'crowdsecurity/' + '{a,b}'.repeat(10) + '-*';
    const condition = {
      field: 'scenario',
      op: 'glob' as const,
      value: ['custom/*', heavy],
    };
    const filter = new ExpressionFilter('test', true, condition);
    const globs = (
      filter as unknown as {
        compiled: WeakMap<object, { globs: { pattern: string; matcher: unknown }[] }>;
      }
    ).compiled.get(condition)!.globs;
    expect(globs[0].matcher).not.toBeNull();
    expect(globs[1].pattern).toBe(heavy);
    expect(globs[1].matcher).toBeNull();

    const check = (scenario: string) =>
      filter.matches({ alert: createMockAlert({ scenario }), timestamp: new Date() });
    for (let i = 0; i < 3; i++) {
      expect(check('crowdsecurity/' + 'ab'.repeat(5) + '-bf')).toEqual({
        matched: true,
        filterName: 'test',
        reason: `scenario matches glob "${heavy}"`,
      });
      expect(check('crowdsecurity/' + 'ab'.repeat(5) + 'c-bf').matched).toBe(false);
      expect(check('crowdsecurity/ssh-bf').matched).toBe(false);
      expect(check('custom/ssh-bf').reason).toBe('scenario matches glob "custom/*"');
    }
  });

  it('resolves pre-split field paths like before', () => {
    const empty = (field: string, alert: Alert) =>
      new ExpressionFilter('test', true, { field, op: 'empty' }).matches({
        alert,
        timestamp: new Date(),
      }).matched;
    const alert = createMockAlert();
    expect(empty('source.ip.length', alert)).toBe(true); // a string is not walked into
    expect(empty('missing.deep.path', alert)).toBe(true);
    expect(empty('source.ip', alert)).toBe(false);
    expect(empty('scenario', alert)).toBe(false);
    expect(empty('source', createMockAlert({ source: null as never }))).toBe(true);
    expect(empty('source.ip', createMockAlert({ source: null as never }))).toBe(true);
  });
});
