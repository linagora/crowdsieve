/**
 * Periodic poller for CrowdSec LAPI's GET /v1/usage-metrics endpoint.
 *
 * For each configured LAPI server we issue a single bouncer-authenticated
 * request (X-Api-Key header), fan out the response into per-bouncer rows
 * (`remediation_components[]` + `log_processors[]`), extract a small set of
 * hot counters into typed columns and persist the rest verbatim as JSON for
 * forensic queries / future schema additions.
 *
 * Defensive design:
 * - Servers without `api_key` are silently skipped (logged at debug).
 * - Per-server errors are logged and the loop continues; one broken LAPI
 *   does not break collection from the others.
 * - The first run fires immediately on `start()` so the dashboard isn't
 *   empty for a full interval after startup.
 */

import type { BaseLogger } from 'pino';
import type { Config, LapiServer } from '../config/index.js';
import type { AlertStorage, NewBouncerMetric } from '../storage/index.js';
import { lapiFetch } from '../lapi/client.js';

export type ComponentKind = 'remediation' | 'log_processor';

interface MetricsItem {
  name?: string;
  value?: number | string;
  unit?: string;
  labels?: Record<string, string | number | boolean | null | undefined>;
  timestamp?: number | string;
}

interface MetricsComponent {
  name?: string;
  type?: string;
  os?: { name?: string; version?: string };
  version?: string;
  metrics?: MetricsItem[];
}

interface UsageMetricsResponse {
  remediation_components?: MetricsComponent[];
  log_processors?: MetricsComponent[];
}

export interface MetricsCollectorOptions {
  config: Config;
  storage: AlertStorage;
  logger: BaseLogger;
  lapiServers: LapiServer[];
}

export interface MetricsCollector {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
}

const HOT_COUNTER_NAMES = {
  active_decisions: 'activeDecisions',
  processed: 'processedItems',
  dropped: 'droppedItems',
  bytes: 'bytesProcessed',
} as const;

type HotCounterKey = (typeof HOT_COUNTER_NAMES)[keyof typeof HOT_COUNTER_NAMES];

/** Sum same-name metric items (CrowdSec emits one per label combination). */
function buildRow(
  server: LapiServer,
  component: MetricsComponent,
  kind: ComponentKind,
  collectedAt: number
): NewBouncerMetric | null {
  const bouncerName = component.name?.trim();
  if (!bouncerName) return null;

  const counters: Record<HotCounterKey, number> = {
    activeDecisions: 0,
    processedItems: 0,
    droppedItems: 0,
    bytesProcessed: 0,
  };

  const items = Array.isArray(component.metrics) ? component.metrics : [];
  for (const item of items) {
    if (!item || typeof item.name !== 'string') continue;
    const target = HOT_COUNTER_NAMES[item.name as keyof typeof HOT_COUNTER_NAMES];
    if (!target) continue;
    const value = typeof item.value === 'number' ? item.value : Number(item.value);
    if (Number.isFinite(value)) {
      counters[target] += value;
    }
  }

  return {
    lapiServerName: server.name,
    componentKind: kind,
    bouncerName,
    bouncerType: component.type ?? null,
    osName: component.os?.name ?? null,
    osVersion: component.os?.version ?? null,
    version: component.version ?? null,
    activeDecisions: counters.activeDecisions,
    processedItems: counters.processedItems,
    droppedItems: counters.droppedItems,
    bytesProcessed: counters.bytesProcessed,
    collectedAt,
    metricsJson: JSON.stringify(items),
  };
}

async function collectFromServer(
  server: LapiServer,
  timeoutMs: number,
  logger: BaseLogger
): Promise<NewBouncerMetric[]> {
  if (!server.api_key) {
    logger.debug({ server: server.name }, 'Skipping LAPI without bouncer api_key');
    return [];
  }

  const response = await lapiFetch(
    server,
    '/v1/usage-metrics',
    {
      method: 'GET',
      headers: {
        'X-Api-Key': server.api_key,
        Accept: 'application/json',
      },
    },
    timeoutMs,
    logger
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.warn(
      { server: server.name, status: response.status, body: body.slice(0, 500) },
      'LAPI /v1/usage-metrics returned non-2xx'
    );
    return [];
  }

  const payload = (await response.json()) as UsageMetricsResponse;
  const collectedAt = Date.now();
  const rows: NewBouncerMetric[] = [];

  for (const component of payload.remediation_components ?? []) {
    const row = buildRow(server, component, 'remediation', collectedAt);
    if (row) rows.push(row);
  }
  for (const component of payload.log_processors ?? []) {
    const row = buildRow(server, component, 'log_processor', collectedAt);
    if (row) rows.push(row);
  }

  return rows;
}

export function createMetricsCollector(opts: MetricsCollectorOptions): MetricsCollector {
  const { config, storage, logger, lapiServers } = opts;
  const intervalMs = config.bouncer_metrics.interval_seconds * 1000;
  const timeoutMs = config.bouncer_metrics.request_timeout_ms;
  const retentionDays = config.bouncer_metrics.retention_days;

  let pollHandle: NodeJS.Timeout | null = null;
  let cleanupHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (stopped) return;
    if (lapiServers.length === 0) {
      logger.debug('No LAPI servers configured; skipping bouncer metrics poll');
      return;
    }

    const allRows: NewBouncerMetric[] = [];
    for (const server of lapiServers) {
      try {
        const rows = await collectFromServer(server, timeoutMs, logger);
        allRows.push(...rows);
      } catch (err) {
        logger.error({ err, server: server.name }, 'Failed to collect bouncer metrics from LAPI');
      }
    }

    if (allRows.length === 0) {
      logger.debug('Bouncer metrics poll produced no rows');
      return;
    }

    try {
      await storage.saveBouncerMetrics(allRows);
      logger.debug({ rows: allRows.length }, 'Persisted bouncer metrics snapshot');
    } catch (err) {
      logger.error({ err, rows: allRows.length }, 'Failed to persist bouncer metrics');
    }
  }

  return {
    start() {
      if (pollHandle || cleanupHandle) return;
      // Kick off an immediate poll so the dashboard isn't empty for the first
      // interval after startup; do not await — startup must not block on LAPI.
      void runOnce();

      pollHandle = setInterval(() => {
        void runOnce();
      }, intervalMs);
      if (pollHandle.unref) pollHandle.unref();

      // Daily retention sweep.
      const dayMs = 24 * 60 * 60 * 1000;
      cleanupHandle = setInterval(() => {
        storage
          .cleanupBouncerMetrics(retentionDays)
          .then((deleted) => {
            if (deleted > 0) {
              logger.info({ deleted }, 'Cleaned up old bouncer metrics rows');
            }
          })
          .catch((err) => {
            logger.error({ err }, 'Bouncer metrics cleanup failed');
          });
      }, dayMs);
      if (cleanupHandle.unref) cleanupHandle.unref();
    },

    stop() {
      stopped = true;
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      if (cleanupHandle) {
        clearInterval(cleanupHandle);
        cleanupHandle = null;
      }
    },

    runOnce,
  };
}
