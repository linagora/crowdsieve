import type { Alert, Decision } from '../models/alert.js';
import type { LapiServer, Config } from '../config/index.js';
import { getMachineToken, CROWDSIEVE_VERSION } from '../auth/machineToken.js';
import {
  DEFAULT_MAX_DECISION_DURATION,
  parseGoDuration,
  prepareDecisionForReplication,
  type DecisionLimits,
  type ReplicatedDecision,
} from './decisions.js';

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

/**
 * Who sent the alerts to replicate, as established by the signals route.
 */
export interface ReplicationSender {
  /**
   * CAPI accepted the sender's `Authorization` header with a 2xx, now or
   * within the validation cache TTL. Fail-open results do not count.
   */
  authenticated: boolean;
  /**
   * Machine id (`id` claim) of the sender's JWT. Only meaningful when
   * `authenticated` is true; never taken from the request body.
   */
  machineId?: string;
  /** Validation reason when not authenticated, for the logs. */
  reason?: string;
  /**
   * `machine_id` values found in the alerts themselves (the CrowdSec agents
   * behind the sending LAPI). Attacker-controlled: only ever used to exclude
   * more targets (loop prevention for configurations that list agent ids),
   * never to authorize a sender.
   */
  reportedMachineIds?: readonly string[];
}

/**
 * - `replicated`: decisions were sent (possibly with per-target failures);
 * - `nothing_to_do`: no replicable decision or no target;
 * - `refused`: the sender is not trusted, nothing was sent.
 */
export type ReplicationOutcome = 'replicated' | 'nothing_to_do' | 'refused';

/** Minimal sink for replication outcomes (implemented by the status service). */
export interface ReplicationStatusSink {
  recordReplicationSuccess(server: string): void;
  recordReplicationFailure(server: string, error: unknown): void;
}

export interface ReplicationService {
  /**
   * Replicate decisions from alerts to configured LAPI servers.
   *
   * Decisions are only replicated when the sender is authenticated against
   * CAPI and its JWT machine id is a trusted one (see
   * {@link getTrustedSourceMachineIds}).
   */
  replicateDecisions(alerts: Alert[], sender: ReplicationSender): Promise<ReplicationOutcome>;
}

/**
 * Machine ids allowed to have their decisions replicated: the union of every
 * `lapi_servers[].source_machine_ids`, whether or not that server is itself a
 * replication target (a LAPI may be a source only).
 *
 * They are compared with the `id` claim of the CAPI JWT the LAPI uses to push
 * its signals, i.e. the `login` of its `online_api_credentials.yaml`.
 */
export function getTrustedSourceMachineIds(config: Pick<Config, 'lapi_servers'>): Set<string> {
  const ids = new Set<string>();
  for (const server of config.lapi_servers || []) {
    for (const id of server.source_machine_ids || []) {
      ids.add(id);
    }
  }
  return ids;
}

// A refused sender is logged at warn level at most once per this interval.
const REFUSAL_LOG_INTERVAL_MS = 15 * 60 * 1000;
// Bound on the number of distinct senders remembered for log rate limiting.
const REFUSAL_LOG_MAX_KEYS = 1000;
// Bound on the number of dropped/capped decisions detailed in a log entry.
const MAX_LOGGED_DECISIONS = 20;

/**
 * Create a ReplicationService that replicates decisions to LAPI servers
 */
export function createReplicationService(
  config: Config,
  logger: ReplicationLogger,
  status?: ReplicationStatusSink
): ReplicationService {
  const timeoutMs = config.proxy.timeout_ms;
  const maxDuration = config.replication?.max_decision_duration ?? DEFAULT_MAX_DECISION_DURATION;
  const decisionLimits: DecisionLimits = {
    maxDuration,
    maxDurationMs: parseGoDuration(maxDuration) ?? 0,
  };
  if (decisionLimits.maxDurationMs <= 0) {
    throw new Error(`Invalid replication.max_decision_duration: "${maxDuration}"`);
  }
  const trustedMachineIds = getTrustedSourceMachineIds(config);
  const refusalLoggedAt = new Map<string, number>();

  /**
   * Log a refused sender at warn level once per REFUSAL_LOG_INTERVAL_MS (per
   * machine id, or per reason for unauthenticated senders), debug otherwise.
   */
  function logRefusal(key: string, details: object, msg: string): void {
    const now = Date.now();
    const last = refusalLoggedAt.get(key);
    if (last !== undefined && now - last < REFUSAL_LOG_INTERVAL_MS) {
      logger.debug(details, msg);
      return;
    }
    if (refusalLoggedAt.size >= REFUSAL_LOG_MAX_KEYS) {
      refusalLoggedAt.clear();
    }
    refusalLoggedAt.set(key, now);
    logger.warn(details, msg);
  }

  /**
   * Check that decisions from this sender may be replicated.
   * Returns the trusted machine id, or undefined (and logs) when refused.
   */
  function authorizeSender(sender: ReplicationSender, alertCount: number): string | undefined {
    if (!sender.authenticated) {
      logRefusal(
        `unauthenticated:${sender.reason ?? 'unknown'}`,
        { reason: sender.reason, alertCount },
        'Not replicating decisions: sender is not authenticated against CAPI'
      );
      return undefined;
    }
    if (!sender.machineId || !trustedMachineIds.has(sender.machineId)) {
      logRefusal(
        `untrusted:${sender.machineId ?? ''}`,
        { machineId: sender.machineId, alertCount },
        'Not replicating decisions: sender machine id is not listed in any lapi_servers[].source_machine_ids'
      );
      return undefined;
    }
    return sender.machineId;
  }

  /**
   * Get LAPI servers that should receive replicated decisions
   */
  function getReplicationTargets(
    senderMachineId: string,
    reportedMachineIds: readonly string[]
  ): LapiServer[] {
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

      // Skip the source server (don't replicate back to origin): the one
      // whose source_machine_ids holds the authenticated JWT machine id, and
      // (for configurations listing agent ids) any server holding one of the
      // machine_ids reported in the alerts. The latter can only remove targets.
      const sourceIds = server.source_machine_ids || [];
      const matched = sourceIds.includes(senderMachineId)
        ? senderMachineId
        : reportedMachineIds.find((id) => sourceIds.includes(id));
      if (matched !== undefined) {
        logger.debug(
          {
            server: server.name,
            sourceMachineId: matched,
            source_machine_ids: server.source_machine_ids,
          },
          'Skipping replication target: source machine is in source_machine_ids'
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
    const origin = typeof decision?.origin === 'string' ? decision.origin.toLowerCase() : '';
    return EXCLUDED_ORIGINS.some((excluded) => origin.includes(excluded.toLowerCase()));
  }

  /**
   * Build the alert payload for POST /v1/alerts, once for all targets:
   * - drops decisions from crowdsieve origins (loop prevention);
   * - keeps only bounded IP remediations (see prepareDecisionForReplication)
   *   and caps their duration, logging what was dropped or capped;
   * - marks replicated decisions with origin 'crowdsieve-replication'.
   */
  function buildAlertPayload(alerts: Alert[]): object[] {
    const dropped: Array<{ scope: unknown; value: unknown; type: unknown; reason: string }> = [];
    let droppedCount = 0;
    const capped: Array<{ value: string; duration: unknown }> = [];

    const payload = alerts
      .map((alert) => {
        const replicableDecisions: ReplicatedDecision[] = [];
        for (const decision of alert.decisions || []) {
          if (shouldExcludeDecision(decision)) continue;
          const check = prepareDecisionForReplication(
            decision,
            alert.scenario,
            REPLICATION_ORIGIN, // Mark as replicated to prevent loops
            decisionLimits
          );
          if (!check.ok) {
            droppedCount++;
            if (dropped.length < MAX_LOGGED_DECISIONS) {
              const d = (decision ?? {}) as Partial<Decision>;
              dropped.push({ scope: d.scope, value: d.value, type: d.type, reason: check.reason });
            }
            continue;
          }
          if (check.capped && capped.length < MAX_LOGGED_DECISIONS) {
            capped.push({ value: check.decision.value, duration: decision.duration });
          }
          replicableDecisions.push(check.decision);
        }

        // Skip alerts with no replicable decisions
        if (replicableDecisions.length === 0) {
          return null;
        }

        return {
          scenario: alert.scenario,
          scenario_hash: alert.scenario_hash,
          scenario_version: alert.scenario_version,
          message: alert.message,
          events_count: alert.events_count ?? 1,
          start_at: alert.start_at,
          stop_at: alert.stop_at,
          capacity: alert.capacity ?? 0,
          leakspeed: alert.leakspeed ?? '0s',
          simulated: alert.simulated ?? false,
          remediation: alert.remediation,
          source: alert.source,
          events: alert.events ?? [],
          decisions: replicableDecisions,
        };
      })
      .filter((alert): alert is NonNullable<typeof alert> => alert !== null);

    if (droppedCount > 0) {
      logger.warn(
        { droppedCount, dropped },
        'Dropped decisions that may not be replicated (scope, type, range width or duration)'
      );
    }
    if (capped.length > 0) {
      logger.warn(
        { maxDuration: decisionLimits.maxDuration, capped },
        'Capped the duration of replicated decisions'
      );
    }
    return payload;
  }

  /**
   * Replicate alerts to a single LAPI server
   */
  async function replicateToServer(server: LapiServer, payload: object[]): Promise<boolean> {
    try {
      const token = await getMachineToken(server, timeoutMs, logger);
      if (!token) {
        logger.warn({ server: server.name }, 'Failed to get machine token for replication');
        status?.recordReplicationFailure(server.name, 'Machine login failed');
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
        status?.recordReplicationFailure(server.name, `LAPI answered HTTP ${response.status}`);
        return false;
      }

      logger.info(
        { server: server.name, alertCount: payload.length },
        'Successfully replicated decisions to LAPI'
      );
      status?.recordReplicationSuccess(server.name);
      return true;
    } catch (err) {
      logger.error({ server: server.name, err }, 'Error replicating decisions to LAPI');
      status?.recordReplicationFailure(server.name, err);
      return false;
    }
  }

  return {
    async replicateDecisions(
      alerts: Alert[],
      sender: ReplicationSender
    ): Promise<ReplicationOutcome> {
      // Filter alerts that have decisions
      const alertsWithDecisions = alerts.filter(
        (alert) => Array.isArray(alert.decisions) && alert.decisions.length > 0
      );

      if (alertsWithDecisions.length === 0) {
        logger.debug({}, 'No alerts with decisions to replicate');
        return 'nothing_to_do';
      }

      // Only replicate decisions from an authenticated, trusted LAPI
      const senderMachineId = authorizeSender(sender, alertsWithDecisions.length);
      if (senderMachineId === undefined) {
        return 'refused';
      }

      // Get replication targets
      const targets = getReplicationTargets(senderMachineId, sender.reportedMachineIds ?? []);

      if (targets.length === 0) {
        logger.debug({}, 'No replication targets configured');
        return 'nothing_to_do';
      }

      // Build the payload once, before fetching any token
      const payload = buildAlertPayload(alertsWithDecisions);
      if (payload.length === 0) {
        logger.debug({}, 'No replicable decisions after filtering');
        return 'nothing_to_do';
      }

      logger.info(
        {
          alertCount: payload.length,
          targetCount: targets.length,
          targets: targets.map((t) => t.name),
        },
        'Starting decision replication'
      );

      // Replicate to all targets in parallel
      const results = await Promise.allSettled(
        targets.map((server) => replicateToServer(server, payload))
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
      return 'replicated';
    },
  };
}
