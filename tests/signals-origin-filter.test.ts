import { describe, it, expect } from 'vitest';
import { isCrowdsieveAlert, CROWDSIEVE_ORIGINS } from '../src/proxy/routes/signals.js';
import type { Alert } from '../src/models/alert.js';

describe('Signals Origin Filtering', () => {
  describe('CROWDSIEVE_ORIGINS constant', () => {
    it('should only contain crowdsieve-replication', () => {
      expect(CROWDSIEVE_ORIGINS).toEqual(['crowdsieve-replication']);
    });

    it('should NOT contain crowdsieve (manual decisions should pass through)', () => {
      expect(CROWDSIEVE_ORIGINS).not.toContain('crowdsieve');
    });
  });

  describe('isCrowdsieveAlert', () => {
    it('should return false for alert without decisions', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return false for alert with undefined decisions', () => {
      const alert = {
        scenario: 'test/scenario',
        message: 'test',
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return false for manual decisions with origin "crowdsieve"', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'crowdsieve',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return true for replicated decisions with origin "crowdsieve-replication"', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'crowdsieve-replication',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(true);
    });

    it('should return false for decisions with origin "capi"', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'capi',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return false for decisions with origin "local"', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'local',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return true if ANY decision has crowdsieve-replication origin', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'capi',
            duration: '4h',
            scope: 'ip',
          },
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '5.6.7.8',
            origin: 'crowdsieve-replication',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(true);
    });

    it('should handle case-insensitive origin matching', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'CROWDSIEVE-REPLICATION',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(true);
    });

    it('should handle mixed case crowdsieve-replication', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: 'CrowdSieve-Replication',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(true);
    });

    it('should return false for empty origin string', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            origin: '',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });

    it('should return false for undefined origin', () => {
      const alert: Alert = {
        scenario: 'test/scenario',
        message: 'test',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '1.2.3.4',
            duration: '4h',
            scope: 'ip',
          },
        ],
      } as Alert;

      expect(isCrowdsieveAlert(alert)).toBe(false);
    });
  });

  describe('Manual vs Replicated Decisions', () => {
    it('should allow manual decisions (origin: crowdsieve) to be forwarded to CAPI', () => {
      // Manual decisions created via dashboard/API have origin 'crowdsieve'
      // These should NOT be filtered out - they should go to CAPI
      const manualDecisionAlert: Alert = {
        scenario: 'manual/ban',
        message: 'Manual ban from dashboard',
        decisions: [
          {
            scenario: 'manual/ban',
            type: 'ban',
            value: '10.0.0.1',
            origin: 'crowdsieve',
            duration: '24h',
            scope: 'ip',
          },
        ],
      } as Alert;

      // isCrowdsieveAlert should return false for manual decisions
      // so they are NOT filtered out and CAN be forwarded to CAPI
      expect(isCrowdsieveAlert(manualDecisionAlert)).toBe(false);
    });

    it('should block replicated decisions (origin: crowdsieve-replication) from CAPI', () => {
      // Replicated decisions have origin 'crowdsieve-replication'
      // These should be filtered out to prevent loops
      const replicatedDecisionAlert: Alert = {
        scenario: 'test/scenario',
        message: 'Replicated from another LAPI',
        decisions: [
          {
            scenario: 'test/scenario',
            type: 'ban',
            value: '10.0.0.2',
            origin: 'crowdsieve-replication',
            duration: '24h',
            scope: 'ip',
          },
        ],
      } as Alert;

      // isCrowdsieveAlert should return true for replicated decisions
      // so they ARE filtered out and NOT forwarded to CAPI
      expect(isCrowdsieveAlert(replicatedDecisionAlert)).toBe(true);
    });
  });
});
