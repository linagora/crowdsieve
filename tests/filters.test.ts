import { describe, it, expect } from 'vitest';
import { FilterEngine } from '../src/filters/index.js';
import { NoDecisionFilter } from '../src/filters/implementations/no-decision.js';
import { SimulatedFilter } from '../src/filters/implementations/simulated.js';
import { ScenarioFilter } from '../src/filters/implementations/scenario.js';
import { SourceCountryFilter } from '../src/filters/implementations/source-country.js';
import { SourceIpFilter } from '../src/filters/implementations/source-ip.js';
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

describe('NoDecisionFilter', () => {
  it('should match alerts without decisions', () => {
    const filter = new NoDecisionFilter('no-decision', true);
    const alert = createMockAlert({ decisions: [] });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
    expect(result.reason).toBe('Alert has no decisions');
  });

  it('should not match alerts with decisions', () => {
    const filter = new NoDecisionFilter('no-decision', true);
    const alert = createMockAlert({
      decisions: [{
        origin: 'crowdsec',
        type: 'ban',
        scope: 'ip',
        value: '192.168.1.100',
        duration: '4h',
        scenario: 'crowdsecurity/ssh-bf',
      }],
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(false);
  });
});

describe('SimulatedFilter', () => {
  it('should match simulated alerts', () => {
    const filter = new SimulatedFilter('simulated', true);
    const alert = createMockAlert({ simulated: true });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should not match non-simulated alerts', () => {
    const filter = new SimulatedFilter('simulated', true);
    const alert = createMockAlert({ simulated: false });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(false);
  });
});

describe('ScenarioFilter', () => {
  it('should match exact scenario', () => {
    const filter = new ScenarioFilter('scenario', true, ['crowdsecurity/ssh-bf'], 'exact');
    const alert = createMockAlert({ scenario: 'crowdsecurity/ssh-bf' });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should match glob pattern', () => {
    const filter = new ScenarioFilter('scenario', true, ['crowdsecurity/*'], 'glob');
    const alert = createMockAlert({ scenario: 'crowdsecurity/http-bf' });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should match regex pattern', () => {
    const filter = new ScenarioFilter('scenario', true, ['.*ssh.*'], 'regex');
    const alert = createMockAlert({ scenario: 'crowdsecurity/ssh-bf' });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should not match non-matching scenario', () => {
    const filter = new ScenarioFilter('scenario', true, ['crowdsecurity/http-*'], 'glob');
    const alert = createMockAlert({ scenario: 'crowdsecurity/ssh-bf' });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(false);
  });
});

describe('SourceCountryFilter', () => {
  it('should match country in blocklist', () => {
    const filter = new SourceCountryFilter('country', true, ['CN', 'RU'], 'blocklist');
    const alert = createMockAlert({
      source: { scope: 'ip', value: '1.2.3.4', cn: 'CN' },
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should not match country not in blocklist', () => {
    const filter = new SourceCountryFilter('country', true, ['CN', 'RU'], 'blocklist');
    const alert = createMockAlert({
      source: { scope: 'ip', value: '1.2.3.4', cn: 'US' },
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(false);
  });

  it('should match country not in allowlist', () => {
    const filter = new SourceCountryFilter('country', true, ['US', 'CA'], 'allowlist');
    const alert = createMockAlert({
      source: { scope: 'ip', value: '1.2.3.4', cn: 'CN' },
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });
});

describe('SourceIpFilter', () => {
  it('should match IP in CIDR blocklist', () => {
    const filter = new SourceIpFilter('ip', true, ['192.168.0.0/16'], 'blocklist');
    const alert = createMockAlert({
      source: { scope: 'ip', value: '192.168.1.100', ip: '192.168.1.100' },
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(true);
  });

  it('should not match IP not in CIDR blocklist', () => {
    const filter = new SourceIpFilter('ip', true, ['192.168.0.0/16'], 'blocklist');
    const alert = createMockAlert({
      source: { scope: 'ip', value: '10.0.0.1', ip: '10.0.0.1' },
    });

    const result = filter.matches({ alert, timestamp: new Date() });

    expect(result.matched).toBe(false);
  });
});

describe('FilterEngine', () => {
  it('should filter alerts in block mode', () => {
    const engine = new FilterEngine('block', [
      { name: 'no-decision', type: 'no-decision', enabled: true },
    ]);

    const alerts = [
      createMockAlert({ decisions: [] }),
      createMockAlert({
        decisions: [{
          origin: 'crowdsec',
          type: 'ban',
          scope: 'ip',
          value: '1.2.3.4',
          duration: '4h',
          scenario: 'test',
        }],
      }),
    ];

    const result = engine.process(alerts);

    expect(result.originalCount).toBe(2);
    expect(result.filteredCount).toBe(1);
    expect(result.passedCount).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].decisions).toHaveLength(1);
  });

  it('should allow alerts in allow mode', () => {
    const engine = new FilterEngine('allow', [
      { name: 'has-decision', type: 'no-decision', enabled: true },
    ]);

    const alerts = [
      createMockAlert({ decisions: [] }),
      createMockAlert({
        decisions: [{
          origin: 'crowdsec',
          type: 'ban',
          scope: 'ip',
          value: '1.2.3.4',
          duration: '4h',
          scenario: 'test',
        }],
      }),
    ];

    const result = engine.process(alerts);

    // In allow mode, non-matching alerts are filtered
    // The no-decision filter matches the first alert (no decisions)
    // So the first alert passes (it matches), the second is filtered (doesn't match)
    expect(result.filteredCount).toBe(1);
    expect(result.passedCount).toBe(1);
  });

  it('should skip disabled filters', () => {
    const engine = new FilterEngine('block', [
      { name: 'no-decision', type: 'no-decision', enabled: false },
    ]);

    const alerts = [createMockAlert({ decisions: [] })];
    const result = engine.process(alerts);

    expect(result.filteredCount).toBe(0);
    expect(result.passedCount).toBe(1);
  });
});
