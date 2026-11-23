import type { AlertDetailDecision } from './types';

/** Events shown before the "Show all" button of the Events card. */
export const EVENTS_COLLAPSED_COUNT = 10;

/** Decision row displayed for a manual-ban audit entry (not a stored decision). */
export interface ManualBanDecision extends AlertDetailDecision {
  server: string | null;
}

/**
 * Manual-ban audit rows carry no `decisions` rows: the ban parameters are in
 * their `raw_json` (`kind`, `server`, `duration`, `ip`, `scope`). Rebuild the
 * decision they stand for so the Decisions card can show it. Returns null for
 * anything else, or when the payload is unusable.
 */
export function manualBanDecisionFromRaw(
  rawJson: string | null | undefined
): ManualBanDecision | null {
  if (!rawJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'manual-ban' || typeof r.ip !== 'string' || r.ip === '') return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    id: typeof r.decisionId === 'number' ? r.decisionId : 0,
    type: 'ban',
    scope: r.scope === 'range' ? 'Range' : 'Ip',
    value: r.ip,
    duration: str(r.duration),
    origin: 'manual',
    scenario: null,
    until: null,
    simulated: false,
    server: str(r.server),
  };
}

/** Whether a decision expiry date is in the past. */
export function isDecisionExpired(until: string | null | undefined, now: number): boolean {
  if (!until) return false;
  const t = Date.parse(until);
  return !Number.isNaN(t) && t < now;
}

/** Pretty-print a stored JSON payload; unparseable text is returned as is. */
export function prettyPrintJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
