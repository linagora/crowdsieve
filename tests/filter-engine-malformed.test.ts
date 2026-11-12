import { describe, it, expect } from 'vitest';
import { FilterEngine } from '../src/filters/index.js';
import { isCrowdsieveAlert } from '../src/proxy/routes/signals.js';
import type { Alert } from '../src/models/alert.js';

describe('FilterEngine on alerts without a source', () => {
  const rule = {
    name: 'block-local',
    enabled: true,
    filter: { field: 'source.ip', op: 'cidr', value: ['10.0.0.0/8'] },
  };

  for (const mode of ['block', 'allow'] as const) {
    for (const source of [undefined, null, 'x', 42, []]) {
      it(`${mode} mode, source = ${JSON.stringify(source)}`, () => {
        const engine = new FilterEngine(mode, [rule as never]);
        const alert = { scenario: 'crowdsecurity/ssh-bf', source } as unknown as Alert;
        const result = engine.process([alert]);
        expect(result.originalCount).toBe(1);
        expect(result.filteredCount + result.passedCount).toBe(1);
        expect(result.filterDetails).toHaveLength(1);
        expect(result.filterDetails[0].sourceIp).toBeUndefined();
      });
    }
  }

  it('keeps string source IPs in the filter details', () => {
    const engine = new FilterEngine('block', [rule as never]);
    const alert = {
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '1.2.3.4', value: '1.2.3.4' },
    } as unknown as Alert;
    const result = engine.process([alert]);
    expect(result.filterDetails[0].sourceIp).toBe('1.2.3.4');
  });

  it('falls back to a string source value', () => {
    const engine = new FilterEngine('block', [rule as never]);
    const alert = {
      scenario: 'crowdsecurity/ssh-bf',
      source: { value: 'user@example.com' },
    } as unknown as Alert;
    const result = engine.process([alert]);
    expect(result.filterDetails[0].sourceIp).toBe('user@example.com');
  });

  it('drops non-string source ip/value fields', () => {
    const engine = new FilterEngine('block', [rule as never]);
    const alert = {
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: 42, value: ['1.2.3.4'] },
    } as unknown as Alert;
    const result = engine.process([alert]);
    expect(result.filterDetails[0].sourceIp).toBeUndefined();
  });
});

describe('isCrowdsieveAlert on schema-valid malformed alerts', () => {
  it('returns false when decisions is not an array', () => {
    for (const decisions of ['crowdsieve-replication', 42, {}, true]) {
      const alert = { scenario: 'test/scenario', decisions } as unknown as Alert;
      expect(isCrowdsieveAlert(alert)).toBe(false);
    }
  });

  it('returns false when a decision is not an object', () => {
    const alert = { scenario: 'test/scenario', decisions: [null, 'x', 42] } as unknown as Alert;
    expect(isCrowdsieveAlert(alert)).toBe(false);
  });

  it('returns false when origin is not a string', () => {
    for (const origin of [42, null, {}, ['crowdsieve-replication']]) {
      const alert = {
        scenario: 'test/scenario',
        decisions: [{ origin }],
      } as unknown as Alert;
      expect(isCrowdsieveAlert(alert)).toBe(false);
    }
  });

  it('still detects a crowdsieve-replication origin among malformed decisions', () => {
    const alert = {
      scenario: 'test/scenario',
      decisions: [null, { origin: 42 }, { origin: 'CrowdSieve-Replication' }],
    } as unknown as Alert;
    expect(isCrowdsieveAlert(alert)).toBe(true);
  });
});
