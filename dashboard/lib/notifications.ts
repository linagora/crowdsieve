import { formatAgo } from './relativeTime';

/** Shape of the proxy's GET /api/notifications answer (see src/notifications). */
export type NotificationEvent =
  'alert' | 'manual_ban' | 'unban' | 'forwarding_error' | 'lapi_error';

export interface NotificationTargetStatus {
  name: string;
  type: 'webhook' | 'slack';
  host: string;
  events: NotificationEvent[];
  minInterval: string;
  minIntervalMs: number;
  match: {
    scenarios: string[];
    countries: string[];
    machines: string[];
    status: 'forwarded' | 'filtered' | 'any';
  } | null;
  lastResult: {
    at: number;
    ok: boolean;
    event: NotificationEvent | 'test';
    message: string;
    attempts: number;
  } | null;
  lastSuccessAt: number | null;
  retrying: { attempt: number; maxAttempts: number; nextAttemptAt: number; message: string } | null;
  queued: number;
  buffered: number;
  dropped: number;
}

export interface NotificationsStatus {
  enabled: boolean;
  dashboardUrl: string | null;
  targets: NotificationTargetStatus[];
}

/** Answer of POST /api/notifications/<name>/test. */
export interface NotificationTestResult {
  ok: boolean;
  message: string;
}

/** Same rule as the proxy: names are used in URLs. */
const TARGET_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidTargetName(name: string): boolean {
  return TARGET_NAME_REGEX.test(name);
}

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  alert: 'Alerts',
  manual_ban: 'Manual bans',
  unban: 'Unbans',
  forwarding_error: 'CAPI forwarding errors',
  lapi_error: 'LAPI errors',
};

export const TARGET_TYPE_LABELS: Record<NotificationTargetStatus['type'], string> = {
  webhook: 'Webhook',
  slack: 'Slack-compatible',
};

export type DeliveryTone = 'green' | 'red' | 'slate';

/** "Delivered 3 min ago", "Failed 2 min ago: HTTP 404" or "No delivery yet". */
export function lastDeliveryLabel(
  target: Pick<NotificationTargetStatus, 'lastResult'>,
  now: number
): { tone: DeliveryTone; text: string } {
  const result = target.lastResult;
  if (!result) return { tone: 'slate', text: 'No delivery yet' };
  const ago = formatAgo(result.at, now);
  return result.ok
    ? { tone: 'green', text: `Delivered ${ago}` }
    : { tone: 'red', text: `Failed ${ago}: ${result.message}` };
}

/** "Retrying (attempt 2 of 4) after HTTP 500", null when not retrying. */
export function retryingLabel(target: Pick<NotificationTargetStatus, 'retrying'>): string | null {
  const r = target.retrying;
  if (!r) return null;
  return `Retrying (attempt ${r.attempt + 1} of ${r.maxAttempts}) after ${r.message}`;
}

/** "Scenarios: ssh-bf, smtp · Countries: FR · Passed the filters". */
export function matchSummary(match: NotificationTargetStatus['match']): string | null {
  if (!match) return null;
  const parts: string[] = [];
  if (match.scenarios.length > 0) parts.push(`Scenarios: ${match.scenarios.join(', ')}`);
  if (match.countries.length > 0) parts.push(`Countries: ${match.countries.join(', ')}`);
  if (match.machines.length > 0) parts.push(`Machines: ${match.machines.join(', ')}`);
  parts.push(
    match.status === 'forwarded'
      ? 'Alerts that passed the filters'
      : match.status === 'filtered'
        ? 'Filtered alerts'
        : 'All alerts'
  );
  return parts.join(' · ');
}

/** "Events grouped over 5m" or "Every event sent on its own". */
export function intervalLabel(
  target: Pick<NotificationTargetStatus, 'minInterval' | 'minIntervalMs'>
): string {
  return target.minIntervalMs > 0
    ? `Events grouped over ${target.minInterval}`
    : 'Every event sent on its own';
}

/** Inline result of "Send test". */
export function testResultLabel(result: NotificationTestResult): string {
  return result.ok ? 'Delivered' : `Failed: ${result.message}`;
}
