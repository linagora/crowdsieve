/**
 * Extraction of an alert's events from its stored `raw_json`.
 *
 * CrowdSieve keeps the complete alert payload in `alerts.raw_json`; that is
 * the only place the events (log lines, targeted URL, service...) are
 * persisted. Event meta keys and values come from the log lines CrowdSec
 * parsed, so they are attacker-controlled: they are only bounded in size here
 * and must be rendered as plain text by consumers.
 */

export interface AlertEventMeta {
  key: string;
  value: string;
}

export interface AlertEventView {
  timestamp: string | null;
  meta: AlertEventMeta[];
}

export interface AlertEventsResult {
  events: AlertEventView[];
  /** Number of events in the stored payload (may exceed `events.length`). */
  total: number;
}

export const DEFAULT_EVENTS_LIMIT = 50;
const MAX_META_ENTRIES = 100;
const MAX_META_KEY_LENGTH = 200;
const MAX_META_VALUE_LENGTH = 2000;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return '';
  }
}

function normalizeMeta(meta: unknown): AlertEventMeta[] {
  const out: AlertEventMeta[] = [];
  if (!Array.isArray(meta)) return out;
  for (const entry of meta) {
    if (out.length >= MAX_META_ENTRIES) break;
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || key === '') continue;
    out.push({
      key: key.slice(0, MAX_META_KEY_LENGTH),
      value: toText(value).slice(0, MAX_META_VALUE_LENGTH),
    });
  }
  return out;
}

function timestampOrder(a: AlertEventView, b: AlertEventView): number {
  const ta = a.timestamp ? Date.parse(a.timestamp) : NaN;
  const tb = b.timestamp ? Date.parse(b.timestamp) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

/**
 * Return the first `limit` events of a stored alert payload, ordered by
 * timestamp (stable, undated events last), and the total event count.
 * Malformed or missing payloads yield no events.
 */
export function extractAlertEvents(
  rawJson: string | null | undefined,
  limit: number = DEFAULT_EVENTS_LIMIT
): AlertEventsResult {
  if (!rawJson) return { events: [], total: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { events: [], total: 0 };
  }

  const rawEvents = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(rawEvents)) return { events: [], total: 0 };

  const events: AlertEventView[] = [];
  for (const ev of rawEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const { timestamp, meta } = ev as { timestamp?: unknown; meta?: unknown };
    events.push({
      timestamp: typeof timestamp === 'string' && timestamp !== '' ? timestamp : null,
      meta: normalizeMeta(meta),
    });
  }

  const sorted = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => timestampOrder(a.event, b.event) || a.index - b.index)
    .map((x) => x.event);

  return { events: sorted.slice(0, Math.max(0, limit)), total: events.length };
}
