import net from 'net';
import type { NotificationEventType, NotificationTarget } from '../config/index.js';

/**
 * Notification items and the payloads sent to the targets: the generic JSON
 * webhook and the Slack-compatible incoming webhook (`{ text }`, also
 * accepted by Mattermost and Rocket.Chat). Pure functions, no I/O.
 */

export interface AlertNotificationItem {
  kind: 'alert';
  occurredAt: number;
  id: number;
  scenario: string | null;
  ip: string | null;
  country: string | null;
  machine: string | null;
  filtered: boolean;
}

export interface ManualBanNotificationItem {
  kind: 'manual_ban';
  occurredAt: number;
  actor: string | null;
  ip: string;
  scope: 'ip' | 'range';
  type: 'ban' | 'captcha';
  duration: string;
  server: string;
  reason: string;
  /** Id of the local audit row (link to /alerts/<id>), when it was recorded. */
  auditId: number | null;
}

export interface UnbanNotificationItem {
  kind: 'unban';
  occurredAt: number;
  actor: string | null;
  ip: string;
  scope: 'ip' | 'range';
  server: string;
  reason: string;
  decisionId: number;
  auditId: number | null;
}

export interface ServiceErrorNotificationItem {
  kind: 'forwarding_error' | 'lapi_error';
  occurredAt: number;
  /** "CAPI" for forwarding errors, the LAPI server name otherwise. */
  server: string;
  state: 'failing' | 'recovered' | 'replication_failed';
  /** Sanitised error message (no credentials), null on recovery. */
  error: string | null;
}

export type NotificationItem =
  | AlertNotificationItem
  | ManualBanNotificationItem
  | UnbanNotificationItem
  | ServiceErrorNotificationItem;

/**
 * Events of one target and event type collected over `min_interval`, sent
 * as a single message. `items` holds the first event and the most recent
 * ones (bounded); `total` and `groups` count every event.
 */
export interface NotificationDigest {
  event: NotificationEventType;
  items: NotificationItem[];
  total: number;
  /** Event count per group (scenario, actor or server), in first-seen order. */
  groups: Map<string, number>;
}

/** Longest value copied into a payload. */
const MAX_VALUE_LENGTH = 256;
/** Upper bound of the `text` of a Slack message. */
export const MAX_SLACK_TEXT_LENGTH = 4000;
/** Item lines written in full in a Slack message, per event type. */
const SLACK_DETAIL_LINES: Record<NotificationEventType, number> = {
  alert: 1,
  manual_ban: 10,
  unban: 10,
  forwarding_error: 10,
  lapi_error: 10,
};
/** Groups listed in a digest line before "…". */
const MAX_DIGEST_GROUPS = 8;

function truncate(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Group of an item in a digest: scenario, actor or server. */
export function groupKey(item: NotificationItem): string {
  switch (item.kind) {
    case 'alert':
      return item.scenario ?? 'unknown scenario';
    case 'manual_ban':
    case 'unban':
      return item.actor ?? 'unknown user';
    default:
      return item.server;
  }
}

/** Does an alert match the `match` section of a target? */
export function alertMatches(
  match: NotificationTarget['match'],
  alert: Pick<AlertNotificationItem, 'scenario' | 'country' | 'machine' | 'filtered'>
): boolean {
  if (match.status === 'forwarded' && alert.filtered) return false;
  if (match.status === 'filtered' && !alert.filtered) return false;
  if (match.scenarios.length > 0) {
    const scenario = (alert.scenario ?? '').toLowerCase();
    if (!match.scenarios.some((s) => scenario.includes(s.toLowerCase()))) return false;
  }
  if (match.countries.length > 0) {
    const country = (alert.country ?? '').toUpperCase();
    if (!match.countries.includes(country)) return false;
  }
  if (match.machines.length > 0) {
    const machine = (alert.machine ?? '').toLowerCase();
    if (!match.machines.some((m) => m.toLowerCase() === machine)) return false;
  }
  return true;
}

function alertLink(dashboardUrl: string | null, id: number | null): string | null {
  return dashboardUrl && id !== null ? `${dashboardUrl}/alerts/${id}` : null;
}

// ---------------------------------------------------------------------------
// Generic JSON webhook
// ---------------------------------------------------------------------------

function jsonItem(item: NotificationItem, dashboardUrl: string | null): Record<string, unknown> {
  const occurred_at = new Date(item.occurredAt).toISOString();
  const str = (value: string | null) => (value === null ? null : truncate(value));
  switch (item.kind) {
    case 'alert':
      return {
        occurred_at,
        id: item.id,
        scenario: str(item.scenario),
        ip: str(item.ip),
        country: str(item.country),
        machine: str(item.machine),
        filtered: item.filtered,
        link: alertLink(dashboardUrl, item.id),
      };
    case 'manual_ban':
      return {
        occurred_at,
        actor: str(item.actor),
        ip: item.ip,
        scope: item.scope,
        type: item.type,
        duration: item.duration,
        server: item.server,
        reason: str(item.reason),
        link: alertLink(dashboardUrl, item.auditId),
      };
    case 'unban':
      return {
        occurred_at,
        actor: str(item.actor),
        ip: item.ip,
        scope: item.scope,
        server: item.server,
        decision_id: item.decisionId,
        reason: str(item.reason),
        link: alertLink(dashboardUrl, item.auditId),
      };
    default:
      return { occurred_at, server: item.server, state: item.state, error: str(item.error) };
  }
}

/**
 * `{ event, occurred_at, crowdsieve_url, items, total, omitted, summary }`.
 * `occurred_at` is the time of the first event; `omitted` is the number of
 * events counted in `total` and `summary` but not listed in `items`.
 */
export function buildWebhookPayload(
  digest: NotificationDigest,
  dashboardUrl: string | null
): Record<string, unknown> {
  return {
    event: digest.event,
    occurred_at: new Date(digest.items[0]?.occurredAt ?? Date.now()).toISOString(),
    crowdsieve_url: dashboardUrl,
    total: digest.total,
    omitted: Math.max(0, digest.total - digest.items.length),
    summary: [...digest.groups].map(([key, count]) => ({ key: truncate(key), count })),
    items: digest.items.map((item) => jsonItem(item, dashboardUrl)),
  };
}

export function testMessage(dashboardUrl: string | null): string {
  return `CrowdSieve test notification from ${dashboardUrl ?? 'CrowdSieve (notifications.dashboard_url is not set)'}`;
}

export function buildTestWebhookPayload(
  dashboardUrl: string | null,
  now: number
): Record<string, unknown> {
  return {
    event: 'test',
    occurred_at: new Date(now).toISOString(),
    crowdsieve_url: dashboardUrl,
    message: testMessage(dashboardUrl),
    total: 0,
    omitted: 0,
    summary: [],
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Slack-compatible text
// ---------------------------------------------------------------------------

/** Escape the three characters Slack's mrkdwn gives a meaning to. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render an untrusted value (scenario, machine, reason, actor, error…) as
 * inline code: Slack, Mattermost and Rocket.Chat render no link, mention or
 * formatting inside it. Backticks and control characters are replaced so the
 * value cannot close the code span or start a new line.
 */
export function slackCode(value: string | null, fallback = 'unknown'): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = (value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  cleaned = cleaned.replace(/`/g, "'");
  if (cleaned === '') cleaned = fallback;
  return `\`${escapeSlack(truncate(cleaned, 200))}\``;
}

/** An IP or CIDR range in plain text when valid, else as inline code. */
function slackIp(value: string | null): string {
  if (value) {
    const [address, prefix, extra] = value.split('/');
    if (
      extra === undefined &&
      net.isIP(address) &&
      (prefix === undefined || /^\d{1,3}$/.test(prefix))
    ) {
      return value;
    }
  }
  return slackCode(value);
}

function slackLink(url: string | null): string {
  return url ? ` — ${escapeSlack(url)}` : '';
}

function slackLine(item: NotificationItem, dashboardUrl: string | null): string {
  switch (item.kind) {
    case 'alert': {
      const country =
        item.country && /^[A-Za-z]{2}$/.test(item.country)
          ? ` (${item.country.toUpperCase()})`
          : '';
      const machine = item.machine ? ` on ${slackCode(item.machine)}` : '';
      const filtered = item.filtered ? ' [filtered]' : '';
      return (
        `🚨 ${slackCode(item.scenario)} from ${slackIp(item.ip)}${country}${machine}${filtered}` +
        slackLink(alertLink(dashboardUrl, item.id))
      );
    }
    case 'manual_ban': {
      const action =
        item.type === 'captcha'
          ? `put ${slackIp(item.ip)} under captcha`
          : `banned ${slackIp(item.ip)}`;
      return (
        `🔒 ${slackCode(item.actor, 'unknown user')} ${action} on ${escapeSlack(item.server)} ` +
        `for ${escapeSlack(item.duration)}: ${slackCode(item.reason)}` +
        slackLink(alertLink(dashboardUrl, item.auditId))
      );
    }
    case 'unban':
      return (
        `🔓 ${slackCode(item.actor, 'unknown user')} unbanned ${slackIp(item.ip)} on ` +
        `${escapeSlack(item.server)} (decision #${item.decisionId}): ${slackCode(item.reason)}` +
        slackLink(alertLink(dashboardUrl, item.auditId))
      );
    case 'forwarding_error':
      return item.state === 'recovered'
        ? '✅ CAPI forwarding works again'
        : `⚠️ CAPI forwarding is failing: ${slackCode(item.error)}`;
    case 'lapi_error': {
      const server = escapeSlack(item.server);
      if (item.state === 'recovered') return `✅ LAPI ${server} is reachable again`;
      if (item.state === 'replication_failed') {
        return `⚠️ Decision replication to LAPI ${server} failed: ${slackCode(item.error)}`;
      }
      return `⚠️ LAPI ${server} is unreachable: ${slackCode(item.error)}`;
    }
  }
}

const EVENT_NOUNS: Record<NotificationEventType, [string, string]> = {
  alert: ['alert', 'alerts'],
  manual_ban: ['manual ban', 'manual bans'],
  unban: ['unban', 'unbans'],
  forwarding_error: ['forwarding error', 'forwarding errors'],
  lapi_error: ['LAPI error', 'LAPI errors'],
};

/**
 * Text of a Slack message: the first event(s) in full, then a digest of the
 * others ("➕ 11 more alerts: `crowdsecurity/ssh-bf` ×8, …").
 */
export function buildSlackText(digest: NotificationDigest, dashboardUrl: string | null): string {
  const detailed = digest.items.slice(0, SLACK_DETAIL_LINES[digest.event]);
  const lines = detailed.map((item) => slackLine(item, dashboardUrl));

  const rest = digest.total - detailed.length;
  if (rest > 0) {
    const groups = new Map(digest.groups);
    for (const item of detailed) {
      const key = groupKey(item);
      const count = (groups.get(key) ?? 0) - 1;
      if (count > 0) groups.set(key, count);
      else groups.delete(key);
    }
    const parts = [...groups]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DIGEST_GROUPS)
      .map(([key, count]) => `${slackCode(key)} ×${count}`);
    if (groups.size > MAX_DIGEST_GROUPS) parts.push('…');
    const noun = EVENT_NOUNS[digest.event][rest > 1 ? 1 : 0];
    const link =
      digest.event === 'alert' && dashboardUrl
        ? slackLink(`${dashboardUrl}/alerts`)
        : (digest.event === 'manual_ban' || digest.event === 'unban') && dashboardUrl
          ? slackLink(`${dashboardUrl}/audit`)
          : '';
    lines.push(`➕ ${rest} more ${noun}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}${link}`);
  }

  // Whole lines only, so that no code span or entity is cut.
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_SLACK_TEXT_LENGTH) {
      kept.push('…');
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join('\n');
}

export function buildSlackPayload(
  digest: NotificationDigest,
  dashboardUrl: string | null
): { text: string } {
  return { text: buildSlackText(digest, dashboardUrl) };
}

export function buildTestSlackPayload(dashboardUrl: string | null): { text: string } {
  return { text: `🔔 ${escapeSlack(testMessage(dashboardUrl))}` };
}
