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
  meta?: {
    utc_now_timestamp?: number;
    window_size_seconds?: number;
    [key: string]: unknown;
  };
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
 * Determine whether the `metrics` array uses the block form
 * (`Array<{ items?: [], meta?: {...} }>`) or the flat item form
 * (`Array<{ name, value, ... }>`).
 *
 * The block form is the modern CrowdSec shape; flat is legacy/test data.
 * An array is considered block form when at least one entry contains an
 * `items` array or a `meta` object (and none of the entries look purely like
 * flat items with a `name` string at the top level on entries that also lack
 * `items`/`meta`).
 *
 * Strategy: an entry is a block if it has `items` or `meta`; it is a flat
 * item if it has a top-level `name` string. We treat the array as block form
 * when ANY entry is identified as a block.
 */
function isBlockForm(metrics: MetricsComponent['metrics']): boolean {
  if (!Array.isArray(metrics)) return false;
  for (const entry of metrics) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (Array.isArray(e['items']) || (e['meta'] !== undefined && typeof e['meta'] === 'object')) {
      return true;
    }
  }
  return false;
}

/**
 * Pick the most recent block from a block-form metrics array.
 *
 * "Most recent" is determined by `block.meta.utc_now_timestamp` (largest
 * value wins). When no block carries a timestamp, we fall back to the last
 * entry in array order (CrowdSec appends blocks chronologically).
 */
function pickLatestBlock(metrics: MetricsComponent['metrics']): MetricsBlock | null {
  if (!Array.isArray(metrics) || metrics.length === 0) return null;

  let bestBlock: MetricsBlock | null = null;
  let bestTs: number | null = null;
  let anyTimestamp = false;

  for (const entry of metrics) {
    if (!entry || typeof entry !== 'object') continue;
    const block = entry as MetricsBlock;
    const ts =
      typeof block.meta?.utc_now_timestamp === 'number' ? block.meta.utc_now_timestamp : null;
    if (ts !== null) {
      anyTimestamp = true;
      if (bestTs === null || ts > bestTs) {
        bestTs = ts;
        bestBlock = block;
      }
    } else {
      // No timestamp on this block — track it as the "last seen" fallback.
      if (!anyTimestamp) {
        bestBlock = block;
      }
    }
  }

  // If we found at least one timestamped block, bestBlock already points to
  // the best one.  If no block had a timestamp, bestBlock is the last entry
  // because we kept overwriting it with each timestamp-less entry (and the
  // `!anyTimestamp` guard means we stop updating once a timestamped entry is
  // seen — but in the pure no-timestamp case we always keep the latest seen,
  // which is the last array element).
  return bestBlock;
}

/**
 * Sum same-name metric items within a single block.
 *
 * CrowdSec emits one item per label combination (e.g. dropped{ipv4} + dropped{ipv6}).
 * We collapse them into a single total per counter name.
 */
function sumItemsByName(items: MetricsItem[]): Record<HotCounterKey, number> {
  const counters: Record<HotCounterKey, number> = {
    activeDecisions: 0,
    processedItems: 0,
    droppedItems: 0,
    bytesProcessed: 0,
  };
  for (const item of items) {
    if (!item || typeof item.name !== 'string') continue;
    const target = HOT_COUNTER_NAMES[item.name as keyof typeof HOT_COUNTER_NAMES];
    if (!target) continue;
    const value = typeof item.value === 'number' ? item.value : Number(item.value);
    if (Number.isFinite(value)) {
      counters[target] += value;
    }
  }
  return counters;
}

/**
 * Select the items to sum and the block's timestamp (ms) from the component's
 * `metrics` field.
 *
 * Block form (modern): picks the latest block's `items[]`.
 * Flat form (legacy):  treats the whole array as `MetricsItem[]`.
 */
function pickLatestSnapshot(
  metrics: MetricsComponent['metrics'],
  _collectedAtFallback: number
): { items: MetricsItem[]; blockTimestampMs: number | null } {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return { items: [], blockTimestampMs: null };
  }

  if (isBlockForm(metrics)) {
    const block = pickLatestBlock(metrics);
    if (!block) return { items: [], blockTimestampMs: null };
    const items: MetricsItem[] = Array.isArray(block.items) ? (block.items as MetricsItem[]) : [];
    const ts =
      typeof block.meta?.utc_now_timestamp === 'number'
        ? block.meta.utc_now_timestamp * 1000
        : null;
    return { items, blockTimestampMs: ts };
  }

  // Flat / legacy form: treat every entry directly as a MetricsItem.
  return { items: metrics as MetricsItem[], blockTimestampMs: null };
}

/** Build a single bouncer metric row from a component descriptor. */
function buildRow(
  lapiServerName: string,
  component: MetricsComponent,
  kind: ComponentKind,
  collectedAt: number
): NewBouncerMetric | null {
  const bouncerName = component.name?.trim();
  if (!bouncerName) return null;

  const { items, blockTimestampMs } = pickLatestSnapshot(component.metrics, collectedAt);
  const counters = sumItemsByName(items);

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
    collectedAt: blockTimestampMs ?? collectedAt,
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
