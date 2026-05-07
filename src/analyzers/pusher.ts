import { createHash } from 'crypto';
import type { Decision } from './config.js';
import type { DetectionResult } from './detection.js';
import type { LapiServer } from '../config/index.js';
import { CROWDSIEVE_VERSION, getMachineToken } from '../auth/machineToken.js';

export interface PushResult {
  server: string;
  success: boolean;
  decisionsPushed: number;
  error?: string;
  decisionIds?: string[];
}

/**
 * Build a CrowdSec alert payload with embedded decisions
 */
function buildAlertPayload(
  results: DetectionResult[],
  decision: Decision,
  analyzerId: string,
  analyzerVersion: string
): object[] {
  const timestamp = new Date().toISOString();
  const scenarioHash = createHash('sha256').update(decision.scenario).digest('hex');

  return results.map((result) => ({
    scenario: decision.scenario,
    scenario_hash: scenarioHash,
    scenario_version: analyzerVersion,
    message: `${decision.reason} (${result.distinctCount} distinct values)`,
    events_count: result.totalCount,
    start_at: result.firstSeen,
    stop_at: result.lastSeen,
    capacity: 1,
    leakspeed: '1s',
    simulated: false,
    remediation: true,
    source: {
      scope: decision.scope,
      value: result.groupValue,
    },
    events: [
      {
        timestamp,
        meta: [
          { key: 'source', value: `crowdsieve-analyzer/${analyzerId}` },
          { key: 'reason', value: decision.reason },
          { key: 'distinct_count', value: String(result.distinctCount) },
          { key: 'total_count', value: String(result.totalCount) },
          { key: 'first_seen', value: result.firstSeen },
          { key: 'last_seen', value: result.lastSeen },
        ],
        source: {
          scope: decision.scope,
          value: result.groupValue,
        },
      },
    ],
    decisions: [
      {
        duration: decision.duration,
        type: decision.type,
        scope: decision.scope,
        value: result.groupValue,
        origin: 'crowdsieve',
        scenario: decision.scenario,
      },
    ],
  }));
}

/**
 * Push decisions to a LAPI server
 */
async function pushToServer(
  server: LapiServer,
  alerts: object[],
  timeoutMs: number,
  logger: {
    error: (obj: object, msg: string) => void;
    debug: (obj: object, msg: string) => void;
    info: (obj: object, msg: string) => void;
  }
): Promise<PushResult> {
  // Check if machine credentials are configured
  if (!server.machine_id || !server.password) {
    return {
      server: server.name,
      success: false,
      decisionsPushed: 0,
      error: 'Machine credentials not configured',
    };
  }

  // Get machine token
  const token = await getMachineToken(server, timeoutMs, logger);
  if (!token) {
    return {
      server: server.name,
      success: false,
      decisionsPushed: 0,
      error: 'Failed to authenticate with LAPI',
    };
  }

  try {
    const response = await fetch(`${server.url}/v1/alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(alerts),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { server: server.name, status: response.status, error: errorBody },
        'LAPI rejected alerts'
      );
      return {
        server: server.name,
        success: false,
        decisionsPushed: 0,
        error: `LAPI error: ${response.status}`,
      };
    }

    const result = (await response.json()) as string[];
    logger.info(
      { server: server.name, decisionsPushed: alerts.length, ids: result },
      'Decisions pushed to LAPI'
    );

    return {
      server: server.name,
      success: true,
      decisionsPushed: alerts.length,
      decisionIds: result,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        server: server.name,
        success: false,
        decisionsPushed: 0,
        error: 'Request timeout',
      };
    }
    return {
      server: server.name,
      success: false,
      decisionsPushed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Push decisions to multiple LAPI servers
 *
 * @param results - Detection results to push
 * @param decision - Decision configuration
 * @param analyzerId - Analyzer ID for tracking
 * @param analyzerVersion - Analyzer version for scenario_version
 * @param targets - Target servers ("all" or specific server names)
 * @param lapiServers - Available LAPI servers
 * @param timeoutMs - Request timeout in milliseconds
 * @param logger - Logger instance
 */
export async function pushDecisions(
  results: DetectionResult[],
  decision: Decision,
  analyzerId: string,
  analyzerVersion: string,
  targets: string[],
  lapiServers: LapiServer[],
  timeoutMs: number,
  logger: {
    error: (obj: object, msg: string) => void;
    debug: (obj: object, msg: string) => void;
    info: (obj: object, msg: string) => void;
  }
): Promise<PushResult[]> {
  if (results.length === 0) {
    return [];
  }

  // Determine which servers to push to
  const targetServers = targets.includes('all')
    ? lapiServers.filter((s) => s.machine_id && s.password)
    : lapiServers.filter((s) => targets.includes(s.name) && s.machine_id && s.password);

  if (targetServers.length === 0) {
    logger.error(
      { targets, availableServers: lapiServers.map((s) => s.name) },
      'No valid target servers found for pushing decisions'
    );
    return [];
  }

  // Build alert payloads
  const alerts = buildAlertPayload(results, decision, analyzerId, analyzerVersion);

  // Push to all target servers in parallel
  const pushResults = await Promise.all(
    targetServers.map((server) => pushToServer(server, alerts, timeoutMs, logger))
  );

  return pushResults;
}
