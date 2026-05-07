/**
 * Pure parser turning a CrowdSec `/v1/usage-metrics` payload (the body of a
 * LAPI -> CAPI relay POST) into the per-bouncer rows we persist.
 *
 * The route in `src/proxy/routes/usage-metrics.ts` calls this synchronously
 * after authenticating the request — keeping the logic side-effect free so it
 * can be unit-tested without a Fastify instance.
 */

import type { NewBouncerMetric } from '../storage/index.js';

export type ComponentKind = 'remediation' | 'log_processor';

export interface MetricsItem {
  name?: string;
  value?: number | string;
  unit?: string;
  labels?: Record<string, string | number | boolean | null | undefined>;
  timestamp?: number | string;
}

export interface MetricsBlock {
  /**
   * CrowdSec sometimes nests items under `metrics[].items[]` (current shape)
   * and sometimes emits a flat `metrics[]` array (older releases). We accept
   * both in {@link buildRowsFromPayload}.
   */
  items?: MetricsItem[];
  [key: string]: unknown;
}

export interface MetricsComponent {
  name?: string;
  type?: string;
  os?: { name?: string; version?: string };
  version?: string;
  /** Either an array of items (legacy) or an array of blocks each containing items. */
  metrics?: MetricsItem[] | MetricsBlock[];
}

export interface UsageMetricsPayload {
  remediation_components?: MetricsComponent[];
  log_processors?: MetricsComponent[];
  [key: string]: unknown;
}

const HOT_COUNTER_NAMES = {
  active_decisions: 'activeDecisions',
  processed: 'processedItems',
  dropped: 'droppedItems',
  bytes: 'bytesProcessed',
} as const;

type HotCounterKey = (typeof HOT_COUNTER_NAMES)[keyof typeof HOT_COUNTER_NAMES];

/**
 * Flatten the `metrics` field of a component into a single list of items.
 *
 * CrowdSec's serialization is inconsistent across releases / component kinds:
 *   - some emit a flat `metrics: [{ name, value, ... }, ...]`
 *   - some emit `metrics: [{ items: [{ name, value, ... }, ...] }, ...]`
 * We accept both and merge them.
 */
function flattenItems(metrics: MetricsComponent['metrics']): MetricsItem[] {
  if (!Array.isArray(metrics)) return [];
  const out: MetricsItem[] = [];
  for (const entry of metrics) {
    if (!entry || typeof entry !== 'object') continue;
    // Heuristic: an entry with a `name` looks like an item; an entry with
    // `items[]` is a wrapper. Some payloads can have both shapes mixed in
    // the same array, so we handle each case independently.
    const block = entry as MetricsBlock & MetricsItem;
    if (Array.isArray(block.items)) {
      for (const it of block.items) {
        if (it && typeof it === 'object') out.push(it);
      }
    }
    if (typeof block.name === 'string') {
      out.push(block as MetricsItem);
    }
  }
  return out;
}

/** Sum same-name metric items (CrowdSec emits one per label combination). */
function buildRow(
  lapiServerName: string,
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

  const items = flattenItems(component.metrics);
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
    lapiServerName,
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

/**
 * Convert a CrowdSec usage-metrics payload into the per-bouncer rows expected
 * by {@link AlertStorage.saveBouncerMetrics}.
 *
 * @param lapiServerName Identifier for the LAPI that relayed this payload.
 *   We use the JWT's `id` (machine_id) so the row carries the LAPI's identity
 *   even when no entry in `lapi_servers[]` matches.
 * @param payload Decoded JSON body; permissive shape — extra fields are kept
 *   verbatim in `metricsJson`.
 * @param collectedAt Unix ms timestamp recorded against every produced row.
 */
export function buildRowsFromPayload(
  lapiServerName: string,
  payload: UsageMetricsPayload,
  collectedAt: number
): NewBouncerMetric[] {
  const rows: NewBouncerMetric[] = [];
  for (const component of payload.remediation_components ?? []) {
    const row = buildRow(lapiServerName, component, 'remediation', collectedAt);
    if (row) rows.push(row);
  }
  for (const component of payload.log_processors ?? []) {
    const row = buildRow(lapiServerName, component, 'log_processor', collectedAt);
    if (row) rows.push(row);
  }
  return rows;
}
