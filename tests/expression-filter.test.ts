import { describe, it, expect } from 'vitest';
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
        type: 'expression',
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
