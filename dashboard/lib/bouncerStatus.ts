import { formatAgo } from './relativeTime';

/** A bouncer that has not reported for longer than this is considered stale. */
export const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * True when the last usage-metrics report is older than the stale threshold.
 * A missing or invalid timestamp is not reported as stale (unknown state).
 */
export function isStale(
  lastSeenAt: number | null | undefined,
  now: number,
  thresholdMs: number = STALE_THRESHOLD_MS
): boolean {
  if (lastSeenAt == null || !Number.isFinite(lastSeenAt)) return false;
  return now - lastSeenAt > thresholdMs;
}

/**
 * "Last report 12 min ago · v1.6.4 · Linux (Debian 12)". Version and OS are
 * only shown when known.
 */
export function formatBouncerDetails(
  b: {
    lastSeenAt?: number | null;
    version?: string | null;
    osName?: string | null;
    osVersion?: string | null;
  },
  now: number
): string {
  const parts: string[] = [];
  if (b.lastSeenAt != null) parts.push(`Last report ${formatAgo(b.lastSeenAt, now)}`);
  if (b.version) parts.push(b.version.startsWith('v') ? b.version : `v${b.version}`);
  if (b.osName) parts.push(b.osVersion ? `${b.osName} (${b.osVersion})` : b.osName);
  return parts.join(' · ');
}
