/**
 * Pure parser turning a CrowdSec `/v1/usage-metrics` payload (the body of a
 * LAPI -> CAPI relay POST) into the per-bouncer rows we persist.
 *
 * The route in `src/proxy/routes/usage-metrics.ts` calls this synchronously
 * after authenticating the request — keeping the logic side-effect free so it
 * can be unit-tested without a Fastify instance.
 *
 * Each DetailedMetrics block in `component.metrics[]` produces ONE row keyed
 * by (lapi_server_name, bouncer_name, component_kind, collectedAt). The unique
 * index makes retransmitted blocks no-ops via ON CONFLICT DO NOTHING.
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
 * CrowdSec appends `@<source-ip>` to bouncer names registered without an
 * explicit name. The IP changes whenever the bouncer container restarts with
 * a fresh Docker IP, so the SAME logical bouncer ends up split across multiple
 * rows. We strip the trailing IPv4/IPv6 suffix so per-window counters
 * accumulate consistently across reboots.
 */
function canonicalizeBouncerName(name: string): string {
  return name.replace(/@(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[0-9a-f:]+)$/i, '');
}

/**
 * Build one row per DetailedMetrics block inside a component descriptor.
 *
 * Block form (modern): one row per `{ items, meta }` entry — each block is one
 *   snapshot in time. `collectedAt` comes from `meta.utc_now_timestamp` (ms).
 *   When the timestamp is absent, we synthesize a unique stamp by offsetting
 *   the fallback by the block's array index so all rows remain insertable.
 *
 * Flat form (legacy): treats the entire array as one implicit block → one row.
 *
 * Empty blocks (items.length === 0) are skipped — they represent freshly
 * registered bouncers that haven't pushed counters yet.
 */
function buildRowsForComponent(
  lapiServerName: string,
  component: MetricsComponent,
  kind: ComponentKind,
  fallbackCollectedAt: number
): NewBouncerMetric[] {
  const rawName = component.name?.trim();
  if (!rawName) return [];
  const bouncerName = canonicalizeBouncerName(rawName);

  // Build a "registration-only" row for components that emit no usable
  // metrics (e.g. LemonLDAP-NG / libwww-perl bouncers that query LAPI but
  // never push counters). Without this, the bouncer is invisible in the
  // dashboard even though it is registered. The metricsJson stays `'[]'`
  // so the homepage SUM (which filters on `metrics_json != '[]'`) ignores
  // these rows.
  const emptyRow = (): NewBouncerMetric => ({
    lapiServerName,
    componentKind: kind,
    bouncerName,
    bouncerType: component.type ?? null,
    osName: component.os?.name ?? null,
    osVersion: component.os?.version ?? null,
    version: component.version ?? null,
    activeDecisions: 0,
    processedItems: 0,
    droppedItems: 0,
    bytesProcessed: 0,
    collectedAt: fallbackCollectedAt,
    metricsJson: '[]',
  });

  // Block form: one row per non-empty block. If no block carries items at
  // all, fall through to the registration-only row below.
  if (Array.isArray(component.metrics) && isBlockForm(component.metrics)) {
    const rows: NewBouncerMetric[] = [];
    let blockIndex = 0;
    for (const entry of component.metrics) {
      if (!entry || typeof entry !== 'object') continue;
      const block = entry as MetricsBlock;
      const items: MetricsItem[] = Array.isArray(block.items) ? (block.items as MetricsItem[]) : [];
      if (items.length === 0) {
        blockIndex++;
        continue;
      }

      const counters = sumItemsByName(items);

      // Each block needs a UNIQUE collectedAt (the unique index requires it).
      // Prefer meta.utc_now_timestamp; otherwise synthesize a unique stamp by
      // offsetting the fallback by the block index to keep all rows insertable.
      const ts =
        typeof block.meta?.utc_now_timestamp === 'number'
          ? block.meta.utc_now_timestamp * 1000
          : fallbackCollectedAt + blockIndex;

      rows.push({
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
        collectedAt: ts,
        metricsJson: JSON.stringify(items),
      });
      blockIndex++;
    }
    return rows.length > 0 ? rows : [emptyRow()];
  }

  // Flat form (legacy/test): treat the whole array as one block → one row.
  const flatItems = Array.isArray(component.metrics) ? (component.metrics as MetricsItem[]) : [];
  if (flatItems.length === 0) return [emptyRow()];
  const counters = sumItemsByName(flatItems);
  return [
    {
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
      collectedAt: fallbackCollectedAt,
      metricsJson: JSON.stringify(flatItems),
    },
  ];
}

/**
 * Convert a CrowdSec usage-metrics payload into the per-bouncer rows expected
 * by {@link AlertStorage.saveBouncerMetrics}.
 *
 * Each DetailedMetrics block produces ONE row keyed by
 * (lapi_server_name, bouncer_name, component_kind, collectedAt). The unique
 * index makes retransmitted blocks no-ops via ON CONFLICT DO NOTHING.
 *
 * @param lapiServerName Identifier for the LAPI that relayed this payload.
 *   We use the JWT's `id` (machine_id) so the row carries the LAPI's identity
 *   even when no entry in `lapi_servers[]` matches.
 * @param payload Decoded JSON body; permissive shape — extra fields are kept
 *   verbatim in `metricsJson`.
 * @param collectedAt Unix ms timestamp used as fallback when a block carries
 *   no `meta.utc_now_timestamp`.
 */
export function buildRowsFromPayload(
  lapiServerName: string,
  payload: UsageMetricsPayload,
  collectedAt: number
): NewBouncerMetric[] {
  const rows: NewBouncerMetric[] = [];
  for (const component of payload.remediation_components ?? []) {
    rows.push(...buildRowsForComponent(lapiServerName, component, 'remediation', collectedAt));
  }
  for (const component of payload.log_processors ?? []) {
    rows.push(...buildRowsForComponent(lapiServerName, component, 'log_processor', collectedAt));
  }
  return rows;
}
