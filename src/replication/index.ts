import type { Alert, Decision } from '../models/alert.js';
import type { LapiServer, Config } from '../config/index.js';
import { getMachineToken, CROWDSIEVE_VERSION } from '../auth/machineToken.js';

// Origin used for replicated decisions - used to prevent replication loops
export const REPLICATION_ORIGIN = 'crowdsieve-replication';

// Origins that should NOT be replicated (to prevent loops)
const EXCLUDED_ORIGINS = ['crowdsieve', 'crowdsieve-replication'];

export interface ReplicationLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

export interface ReplicationService {
  /**
   * Replicate decisions from alerts to configured LAPI servers
   * @param alerts - The alerts containing decisions to replicate
   * @param sourceMachineId - The machine ID of the source (to avoid replicating back)
   */
  replicateDecisions(alerts: Alert[], sourceMachineId?: string): Promise<void>;
}

/**
 * Create a ReplicationService that replicates decisions to LAPI servers
 */
export function createReplicationService(
  config: Config,
  logger: ReplicationLogger
): ReplicationService {
  const timeoutMs = config.proxy.timeout_ms;

  /**
   * Get LAPI servers that should receive replicated decisions
   */
  function getReplicationTargets(sourceMachineId?: string): LapiServer[] {
    return (config.lapi_servers || []).filter((server) => {
      // Skip servers without replicate_decisions enabled
      if (!server.replicate_decisions) {
        return false;
      }

      // Skip servers without machine credentials
      if (!server.machine_id || !server.password) {
        logger.debug(
          { server: server.name },
          'Skipping replication target: no machine credentials'
        );
        return false;
      }

      // Skip the source server (don't replicate back to origin)
      if (sourceMachineId && server.machine_id === sourceMachineId) {
        logger.debug(
          { server: server.name, sourceMachineId },
          'Skipping replication target: same as source'
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Check if a decision should be excluded from replication (to prevent loops)
   */
  function shouldExcludeDecision(decision: Decision): boolean {
    const origin = decision.origin?.toLowerCase() || '';
    return EXCLUDED_ORIGINS.some((excluded) => origin.includes(excluded.toLowerCase()));
  }

  /**
   * Filter decisions that should be replicated (exclude crowdsieve origins to prevent loops)
   */
  function filterReplicableDecisions(decisions: Decision[]): Decision[] {
    return decisions.filter((d) => !shouldExcludeDecision(d));
  }

  /**
   * Build the alert payload for POST /v1/alerts
   * - Filters out decisions that shouldn't be replicated (crowdsieve origins)
   * - Changes origin to 'crowdsieve-replication' to prevent loops
   */
  function buildAlertPayload(alerts: Alert[]): object[] {
    return alerts
      .map((alert) => {
        // Filter decisions and change their origin
        const replicableDecisions = filterReplicableDecisions(alert.decisions || []).map(
          (decision) => ({
            ...decision,
            origin: REPLICATION_ORIGIN, // Mark as replicated to prevent loops
          })
        );

        // Skip alerts with no replicable decisions
        if (replicableDecisions.length === 0) {
          return null;
        }

        return {
          scenario: alert.scenario,
          scenario_hash: alert.scenario_hash,
          scenario_version: alert.scenario_version,
          message: alert.message,
          events_count: alert.events_count,
          start_at: alert.start_at,
          stop_at: alert.stop_at,
          capacity: alert.capacity,
          leakspeed: alert.leakspeed,
          simulated: alert.simulated,
          remediation: alert.remediation,
          source: alert.source,
          events: alert.events,
          decisions: replicableDecisions,
        };
      })
      .filter((alert): alert is NonNullable<typeof alert> => alert !== null);
  }

  /**
   * Replicate alerts to a single LAPI server
   */
  async function replicateToServer(server: LapiServer, alerts: Alert[]): Promise<boolean> {
    try {
      // Build payload first to avoid unnecessary token fetch if nothing to replicate
      const payload = buildAlertPayload(alerts);

      // Skip if no alerts to replicate (all decisions were filtered out)
      if (payload.length === 0) {
        logger.debug(
          { server: server.name },
          'No replicable decisions after filtering (all from crowdsieve origin)'
        );
        return true; // Not a failure, just nothing to do
      }

      const token = await getMachineToken(server, timeoutMs, logger);
      if (!token) {
        logger.warn({ server: server.name }, 'Failed to get machine token for replication');
        return false;
      }

      const response = await fetch(`${server.url}/v1/alerts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { server: server.name, status: response.status, error: errorBody },
          'Failed to replicate decisions to LAPI'
        );
        return false;
      }

      logger.info(
        { server: server.name, alertCount: payload.length },
        'Successfully replicated decisions to LAPI'
      );
      return true;
    } catch (err) {
      logger.error({ server: server.name, err }, 'Error replicating decisions to LAPI');
      return false;
    }
  }

  return {
    async replicateDecisions(alerts: Alert[], sourceMachineId?: string): Promise<void> {
      // Filter alerts that have decisions
      const alertsWithDecisions = alerts.filter(
        (alert) => alert.decisions && alert.decisions.length > 0
      );

      if (alertsWithDecisions.length === 0) {
        logger.debug({}, 'No alerts with decisions to replicate');
        return;
      }

      // Get replication targets
      const targets = getReplicationTargets(sourceMachineId);

      if (targets.length === 0) {
        logger.debug({}, 'No replication targets configured');
        return;
      }

      logger.info(
        {
          alertCount: alertsWithDecisions.length,
          targetCount: targets.length,
          targets: targets.map((t) => t.name),
        },
        'Starting decision replication'
      );

      // Replicate to all targets in parallel
      const results = await Promise.allSettled(
        targets.map((server) => replicateToServer(server, alertsWithDecisions))
      );

      // Log summary
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
      const failed = targets.length - succeeded;

      if (failed > 0) {
        logger.warn(
          { succeeded, failed, total: targets.length },
          'Replication completed with some failures'
        );
      } else {
        logger.info({ succeeded, total: targets.length }, 'Replication completed successfully');
      }
    },
  };
}
