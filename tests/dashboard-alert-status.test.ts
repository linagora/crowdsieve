import { describe, expect, it } from 'vitest';
import {
  getAlertKind,
  showsFilteredBadge,
  showsForwardedBadge,
} from '../dashboard/lib/alertStatus.js';
import type { StoredAlert } from '../dashboard/lib/types.js';

function makeAlert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: 1,
    scenario: 'crowdsecurity/ssh-bf',
    receivedAt: '2026-11-11T12:24:20.330Z',
    simulated: false,
    hasDecisions: true,
    filtered: false,
    forwardedToCapi: true,
    replicated: false,
    ...overrides,
  } as StoredAlert;
}

describe('getAlertKind', () => {
  it('should return alert for regular alerts', () => {
    expect(getAlertKind(makeAlert())).toBe('alert');
  });

  it('should identify the audit kind from the scenario', () => {
    expect(getAlertKind(makeAlert({ localAudit: true, scenario: 'crowdsieve/unban' }))).toBe(
      'unban'
    );
    expect(getAlertKind(makeAlert({ localAudit: true, scenario: 'crowdsieve/manual-audit' }))).toBe(
      'manual-ban'
    );
  });

  it('should treat any other local audit row as a generic audit', () => {
    expect(getAlertKind(makeAlert({ localAudit: true, scenario: 'crowdsieve/other' }))).toBe(
      'audit'
    );
  });
});

describe('status badges', () => {
  it('should show filtered/forwarded badges on regular alerts', () => {
    const alert = makeAlert({ filtered: true, forwardedToCapi: true });
    expect(showsFilteredBadge(alert)).toBe(true);
    expect(showsForwardedBadge(alert)).toBe(true);
  });

  it('should suppress filtered/forwarded badges on audit rows', () => {
    // Audit rows are stored with filtered=true but are not filtered alerts.
    const manualAudit = makeAlert({
      localAudit: true,
      scenario: 'crowdsieve/manual-audit',
      filtered: true,
      forwardedToCapi: true,
    });
    expect(showsFilteredBadge(manualAudit)).toBe(false);
    expect(showsForwardedBadge(manualAudit)).toBe(false);
  });

  it('should keep a regular alert without status badges when nothing applies', () => {
    const alert = makeAlert({ filtered: false, forwardedToCapi: false });
    expect(showsFilteredBadge(alert)).toBe(false);
    expect(showsForwardedBadge(alert)).toBe(false);
  });
});
