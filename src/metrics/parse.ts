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
 * Sum the per-window counters (`dropped`, `processed`, `bytes`) across **all**
 * blocks in a component's `metrics` array.
 *
 * CrowdSec emits one block per `WindowSizeSeconds` window with **per-window**
 * counter values (NOT cumulative): each block's `dropped`/`processed`/`bytes`
 * count only what happened during that window. Producing a meaningful total
 * therefore requires summing every block we receive in the relay.
 *
 * The active-decisions gauge is handled separately (see {@link pickLatestSnapshot})
 * — gauges represent a current state, so we take the latest block's value
 * rather than summing.
 *
 * Both block-form (`Array<{ items?, meta? }>`) and flat-form
 * (`Array<MetricsItem>`) inputs are accepted, mirroring {@link pickLatestSnapshot}.
 * For the flat form, summing across "all blocks" reduces to summing across
 * all top-level items, since the whole array is a single implicit block.
 *
 * Returns an object holding totals only for the per-window counters; the
 * `activeDecisions` field is intentionally NOT touched here (always 0).
 */
function aggregateAllBlocks(metrics: MetricsComponent['metrics']): Record<HotCounterKey, number> {
  const counters: Record<HotCounterKey, number> = {
    activeDecisions: 0,
    processedItems: 0,
    droppedItems: 0,
    bytesProcessed: 0,
  };
  if (!Array.isArray(metrics) || metrics.length === 0) return counters;

  const accumulate = (items: MetricsItem[]) => {
    for (const item of items) {
      if (!item || typeof item.name !== 'string') continue;
      // Skip the gauge — its value comes from the latest block only.
      if (item.name === 'active_decisions') continue;
      const target = HOT_COUNTER_NAMES[item.name as keyof typeof HOT_COUNTER_NAMES];
      if (!target) continue;
      const value = typeof item.value === 'number' ? item.value : Number(item.value);
      if (Number.isFinite(value)) {
        counters[target] += value;
      }
    }
  };

  if (isBlockForm(metrics)) {
    for (const entry of metrics) {
      if (!entry || typeof entry !== 'object') continue;
      const block = entry as MetricsBlock;
      const items: MetricsItem[] = Array.isArray(block.items) ? (block.items as MetricsItem[]) : [];
      accumulate(items);
    }
  } else {
    accumulate(metrics as MetricsItem[]);
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

/**
 * CrowdSec appends `@<source-ip>` to bouncer names registered without an
 * explicit name. The IP changes whenever the bouncer container restarts with
 * a fresh Docker IP, so the SAME logical bouncer ends up split across multiple
 * rows. We strip the trailing IPv4/IPv6 suffix so per-window counters
 * accumulate consistently across reboots.
 */
function canonicalizeBouncerName(name: string): string {
  return name.replace(/@(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[0-9a-f:]+)$/i, '');
}

/** Build a single bouncer metric row from a component descriptor. */
function buildRow(
  lapiServerName: string,
  component: MetricsComponent,
  kind: ComponentKind,
  collectedAt: number
): NewBouncerMetric | null {
  const rawName = component.name?.trim();
  if (!rawName) return null;
  const bouncerName = canonicalizeBouncerName(rawName);

  // Different metric kinds have different semantics:
  // - Counters (`dropped`, `processed`, `bytes`) are **per-window** values:
  //   each block reports only what happened during its window. We sum them
  //   across every block the relay carries.
  // - The gauge (`active_decisions`) reports a **current state**: we take the
  //   latest block's value (and sum within that block across labels).
  //
  // We compute both halves independently and merge into one row.
  const counters = aggregateAllBlocks(component.metrics);
  const { items: latestItems, blockTimestampMs } = pickLatestSnapshot(
    component.metrics,
    collectedAt
  );
  const gauge = sumItemsByName(latestItems);

  // Skip components that have no metrics at all — typically a freshly
  // registered bouncer that the LAPI relays before it has pushed any
  // counters. We still emit a row whenever any per-window counter
  // contributed any value, even if the gauge happens to be empty (e.g. an
  // empty latest block following an active window).
  const hasGaugeData = latestItems.length > 0;
  const hasCounterData =
    counters.processedItems !== 0 || counters.droppedItems !== 0 || counters.bytesProcessed !== 0;
  if (!hasGaugeData && !hasCounterData) return null;

  return {
    lapiServerName,
    componentKind: kind,
    bouncerName,
    bouncerType: component.type ?? null,
    osName: component.os?.name ?? null,
    osVersion: component.os?.version ?? null,
    version: component.version ?? null,
    activeDecisions: gauge.activeDecisions,
    processedItems: counters.processedItems,
    droppedItems: counters.droppedItems,
    bytesProcessed: counters.bytesProcessed,
    collectedAt: blockTimestampMs ?? collectedAt,
    metricsJson: JSON.stringify(latestItems),
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
