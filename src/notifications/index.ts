import { CROWDSIEVE_VERSION } from '../auth/machineToken.js';
import type {
  NotificationEventType,
  NotificationTarget,
  NotificationsConfig,
} from '../config/index.js';
import { parseGoDuration } from '../replication/decisions.js';
import { sanitizeError, urlHost, type StatusEvent } from '../status/index.js';
import { MANUAL_BAN_SCENARIO, type StoredAlertSummary } from '../storage/index.js';
import {
  alertMatches,
  buildSlackPayload,
  buildTestSlackPayload,
  buildTestWebhookPayload,
  buildWebhookPayload,
  groupKey,
  type NotificationDigest,
  type NotificationItem,
} from './format.js';

export * from './format.js';

/**
 * Webhook notifications: alerts, manual bans and unbans, CAPI forwarding and
 * LAPI failures are posted to the targets of the `notifications` section.
 *
 * Everything is asynchronous and in memory: producers (the signals route,
 * the ban routes, the status service) only push an event into a bounded
 * per-target buffer and return. Per target and event type, the first event
 * is sent after a short grouping delay, and the events arriving within
 * `min_interval` of a message are grouped in one digest sent when the
 * interval ends. Each target has its own outbox, delivered one message at a
 * time and retried after 5 s, 30 s and 2 min on network errors, timeouts,
 * HTTP 408, 429 and 5xx.
 *
 * Target URLs and headers come from the operator's configuration, but they
 * are still secrets: only the target name and the URL host ever appear in
 * logs and in the status snapshot, and error messages are sanitised.
 * Redirects are never followed.
 */

/** Delays before the 2nd, 3rd and 4th attempt of a delivery. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 30_000, 120_000]);
/** Wait before sending the first event of a burst, to group its siblings. */
export const DEFAULT_GROUP_WAIT_MS = 1_000;
/** Upper bound of one HTTP delivery (connect, answer and body). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Events kept in full per target and event type until they are sent. */
export const MAX_BUFFERED_ITEMS = 100;
/** Distinct digest groups (scenarios, actors, servers) per buffer. */
const MAX_GROUPS = 100;
const OTHER_GROUP = 'other';
/** Messages waiting for delivery per target; the oldest is dropped beyond. */
export const MAX_OUTBOX_MESSAGES = 20;
/** Response bytes read (and discarded) before the body is cancelled. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Minimal delay between two test messages to the same target. */
export const TEST_COOLDOWN_MS = 5_000;

export type TimerHandle = unknown;

export interface NotificationTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultTimers: NotificationTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface NotificationLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface NotificationServiceOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  timers?: NotificationTimers;
  retryDelaysMs?: readonly number[];
  groupWaitMs?: number;
  requestTimeoutMs?: number;
}

export interface DeliveryResult {
  at: number;
  ok: boolean;
  /** Event type of the message, or 'test'. */
  event: NotificationEventType | 'test';
  /** "HTTP 204", "HTTP 500", "Request timed out"… (never a URL or header). */
  message: string;
  /** Attempts made for this message. */
  attempts: number;
}

export interface NotificationTargetStatus {
  name: string;
  type: NotificationTarget['type'];
  /** Host of the URL (no credentials, path or query). */
  host: string;
  events: NotificationEventType[];
  minInterval: string;
  minIntervalMs: number;
  /** Alert filter, null when the target does not receive alerts. */
  match: NotificationTarget['match'] | null;
  lastResult: DeliveryResult | null;
  lastSuccessAt: number | null;
  /** Set while a failed message waits for its next attempt. */
  retrying: { attempt: number; maxAttempts: number; nextAttemptAt: number; message: string } | null;
  /** Messages waiting for delivery (including the one being retried). */
  queued: number;
  /** Events waiting for the end of the grouping delay or of min_interval. */
  buffered: number;
  /** Messages dropped because the outbox was full, since start-up. */
  dropped: number;
}

export interface NotificationsSnapshot {
  enabled: boolean;
  dashboardUrl: string | null;
  targets: NotificationTargetStatus[];
}

export interface TestResult {
  ok: boolean;
  /** "Delivered", or why the delivery failed. */
  message: string;
  /** True when the test was refused because one was sent just before. */
  throttled?: boolean;
}

export interface ManualBanNotification {
  actor: string | null;
  ip: string;
  scope: 'ip' | 'range';
  type: 'ban' | 'captcha';
  duration: string;
  server: string;
  reason: string;
  auditId: number | null;
}

export interface UnbanNotification {
  actor: string | null;
  ip: string;
  scope: 'ip' | 'range';
  server: string;
  reason: string;
  decisionId: number;
  auditId: number | null;
}

export interface NotificationService {
  /** True when at least one target is configured. */
  readonly enabled: boolean;
  /** Queue the stored alerts of a signals batch for the targets they match. */
  notifyAlerts(alerts: readonly StoredAlertSummary[]): void;
  notifyManualBan(event: ManualBanNotification): void;
  notifyUnban(event: UnbanNotification): void;
  /** Feed status-service events (CAPI forwarding, LAPI health, replication). */
  handleStatusEvent(event: StatusEvent): void;
  /** Send a test message right away (no retry). null for an unknown target. */
  sendTest(name: string): Promise<TestResult | null>;
  getSnapshot(): NotificationsSnapshot;
  /** Cancel every timer and drop what was not sent yet. */
  stop(): void;
}

interface Buffer {
  items: NotificationItem[];
  total: number;
  groups: Map<string, number>;
  overflowLogged: boolean;
}

interface OutboxMessage {
  event: NotificationEventType;
  body: string;
  /** Events in the message (for logs). */
  total: number;
}

interface TargetRuntime {
  target: NotificationTarget;
  host: string;
  minIntervalMs: number;
  secrets: string[];
  buffers: Map<NotificationEventType, Buffer>;
  flushTimers: Map<NotificationEventType, TimerHandle>;
  lastFlushAt: Map<NotificationEventType, number>;
  outbox: OutboxMessage[];
  inFlight: boolean;
  attempt: number;
  retryTimer: TimerHandle | null;
  retrying: NotificationTargetStatus['retrying'];
  lastResult: DeliveryResult | null;
  lastSuccessAt: number | null;
  lastTestAt: number | null;
  dropped: number;
}

interface AttemptResult {
  ok: boolean;
  message: string;
  retryable: boolean;
}

/** Read and discard at most `max` bytes of a response, then release it. */
async function discardBody(res: Response, max = MAX_RESPONSE_BYTES): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  let read = 0;
  try {
    while (read < max) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value?.byteLength ?? 0;
    }
    await reader.cancel();
  } catch {
    // The status is all we need.
  }
}

/** Values that must never appear in logs or error messages for a target. */
function targetSecrets(target: NotificationTarget): string[] {
  const secrets = [target.url, ...Object.values(target.headers)];
  try {
    // sanitizeError drops query strings first: the path must be masked on
    // its own too (webhook URLs often carry their secret in the path).
    const url = new URL(target.url);
    if (url.pathname.length > 1) secrets.push(`${url.pathname}${url.search}`, url.pathname);
    if (url.search.length > 1) secrets.push(url.search);
  } catch {
    // Validated by the config schema.
  }
  // Longest first, so that a secret containing another one is masked whole.
  return secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

export function createNotificationService(
  config: NotificationsConfig,
  logger: NotificationLogger,
  options: NotificationServiceOptions = {}
): NotificationService {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const groupWaitMs = options.groupWaitMs ?? DEFAULT_GROUP_WAIT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const dashboardUrl = config.dashboard_url ?? null;
  const maxAttempts = retryDelays.length + 1;
  let stopped = false;
  // CAPI forwarding: notify the start and the end of a failure streak only.
  let capiFailing = false;

  const runtimes = new Map<string, TargetRuntime>();
  for (const target of config.targets) {
    runtimes.set(target.name, {
      target,
      host: urlHost(target.url),
      minIntervalMs: Math.max(0, parseGoDuration(target.min_interval) ?? 0),
      secrets: targetSecrets(target),
      buffers: new Map(),
      flushTimers: new Map(),
      lastFlushAt: new Map(),
      outbox: [],
      inFlight: false,
      attempt: 0,
      retryTimer: null,
      retrying: null,
      lastResult: null,
      lastSuccessAt: null,
      lastTestAt: null,
      dropped: 0,
    });
  }

  async function post(rt: TargetRuntime, body: string): Promise<AttemptResult> {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    try {
      const res = await doFetch(rt.target.url, {
        method: 'POST',
        headers: {
          'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
          ...rt.target.headers,
          'Content-Type': 'application/json',
        },
        body,
        // A redirect could lead anywhere: report it instead of following it.
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await discardBody(res);
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, message: `HTTP ${res.status}`, retryable: false };
      }
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return {
          ok: false,
          message: `HTTP ${res.status || 'redirect'} (redirects are not followed)`,
          retryable: false,
        };
      }
      return {
        ok: false,
        message: `HTTP ${res.status}`,
        retryable: res.status >= 500 || res.status === 408 || res.status === 429,
      };
    } catch (err) {
      return { ok: false, message: sanitizeError(err, rt.secrets), retryable: true };
    }
  }

  function schedulePump(rt: TargetRuntime): void {
    void pump(rt).catch((err) => {
      rt.inFlight = false;
      logger.error(
        { target: rt.target.name, error: sanitizeError(err, rt.secrets) },
        'Notification delivery crashed'
      );
    });
  }

  /** Deliver the outbox of a target, one message at a time. */
  async function pump(rt: TargetRuntime): Promise<void> {
    if (stopped || rt.inFlight || rt.retryTimer !== null) return;
    const message = rt.outbox[0];
    if (!message) return;

    rt.inFlight = true;
    rt.attempt += 1;
    const result = await post(rt, message.body);
    rt.inFlight = false;
    if (stopped) return;

    const at = now();
    if (!result.ok && result.retryable && rt.attempt < maxAttempts) {
      const delay = retryDelays[rt.attempt - 1];
      rt.retrying = {
        attempt: rt.attempt,
        maxAttempts,
        nextAttemptAt: at + delay,
        message: result.message,
      };
      logger.warn(
        {
          target: rt.target.name,
          event: message.event,
          attempt: rt.attempt,
          retryInMs: delay,
          error: result.message,
        },
        'Notification delivery failed, will retry'
      );
      rt.retryTimer = timers.setTimeout(() => {
        rt.retryTimer = null;
        schedulePump(rt);
      }, delay);
      return;
    }

    rt.outbox.shift();
    rt.lastResult = {
      at,
      ok: result.ok,
      event: message.event,
      message: result.ok ? 'Delivered' : result.message,
      attempts: rt.attempt,
    };
    rt.retrying = null;
    if (result.ok) {
      rt.lastSuccessAt = at;
    } else {
      logger.error(
        {
          target: rt.target.name,
          event: message.event,
          attempts: rt.attempt,
          events: message.total,
          error: result.message,
        },
        'Notification delivery failed'
      );
    }
    rt.attempt = 0;
    schedulePump(rt);
  }

  function enqueueMessage(rt: TargetRuntime, message: OutboxMessage): void {
    rt.outbox.push(message);
    // Never drop the message being delivered or waiting for its retry.
    while (rt.outbox.length > MAX_OUTBOX_MESSAGES) {
      const dropped = rt.outbox.splice(1, 1)[0];
      rt.dropped += 1;
      logger.warn(
        { target: rt.target.name, event: dropped?.event, events: dropped?.total },
        'Notification outbox full, dropping the oldest waiting message'
      );
    }
    schedulePump(rt);
  }

  function flush(rt: TargetRuntime, event: NotificationEventType): void {
    rt.flushTimers.delete(event);
    const buffer = rt.buffers.get(event);
    rt.buffers.delete(event);
    if (stopped || !buffer || buffer.total === 0) return;
    rt.lastFlushAt.set(event, now());

    const digest: NotificationDigest = {
      event,
      items: buffer.items,
      total: buffer.total,
      groups: buffer.groups,
    };
    const payload =
      rt.target.type === 'slack'
        ? buildSlackPayload(digest, dashboardUrl)
        : buildWebhookPayload(digest, dashboardUrl);
    enqueueMessage(rt, { event, body: JSON.stringify(payload), total: buffer.total });
  }

  function addToBuffer(rt: TargetRuntime, item: NotificationItem): void {
    const event = item.kind;
    let buffer = rt.buffers.get(event);
    if (!buffer) {
      buffer = { items: [], total: 0, groups: new Map(), overflowLogged: false };
      rt.buffers.set(event, buffer);
    }
    buffer.total += 1;
    let key = groupKey(item);
    if (!buffer.groups.has(key) && buffer.groups.size >= MAX_GROUPS) key = OTHER_GROUP;
    buffer.groups.set(key, (buffer.groups.get(key) ?? 0) + 1);
    buffer.items.push(item);
    if (buffer.items.length > MAX_BUFFERED_ITEMS) {
      // Keep the first event (shown in full) and the most recent ones; the
      // dropped ones are still counted in the digest.
      buffer.items.splice(1, 1);
      if (!buffer.overflowLogged) {
        buffer.overflowLogged = true;
        logger.warn(
          { target: rt.target.name, event, kept: MAX_BUFFERED_ITEMS },
          'Notification buffer full, dropping the oldest events (still counted in the digest)'
        );
      }
    }

    if (!rt.flushTimers.has(event)) {
      const t = now();
      const last = rt.lastFlushAt.get(event);
      const at = Math.max(t + groupWaitMs, last !== undefined ? last + rt.minIntervalMs : 0);
      rt.flushTimers.set(
        event,
        timers.setTimeout(() => flush(rt, event), Math.max(0, at - t))
      );
    }
  }

  function dispatch(
    item: NotificationItem,
    accept?: (target: NotificationTarget) => boolean
  ): void {
    if (stopped) return;
    for (const rt of runtimes.values()) {
      if (!rt.target.events.includes(item.kind)) continue;
      if (accept && !accept(rt.target)) continue;
      addToBuffer(rt, item);
    }
  }

  return {
    enabled: runtimes.size > 0,

    notifyAlerts(alerts) {
      if (stopped || runtimes.size === 0) return;
      const at = now();
      for (const alert of alerts) {
        // Manual bans come back through signals: the manual_ban event covers them.
        if (alert.scenario === MANUAL_BAN_SCENARIO) continue;
        const item: NotificationItem = {
          kind: 'alert',
          occurredAt: at,
          id: alert.id,
          scenario: alert.scenario,
          ip: alert.ip,
          country: alert.country,
          machine: alert.machineId,
          filtered: alert.filtered,
        };
        dispatch(item, (target) => alertMatches(target.match, item));
      }
    },

    notifyManualBan(event) {
      dispatch({ kind: 'manual_ban', occurredAt: now(), ...event });
    },

    notifyUnban(event) {
      dispatch({ kind: 'unban', occurredAt: now(), ...event });
    },

    handleStatusEvent(event) {
      switch (event.type) {
        case 'capi_forward_failed':
          if (capiFailing) return;
          capiFailing = true;
          dispatch({
            kind: 'forwarding_error',
            occurredAt: event.at,
            server: 'CAPI',
            state: 'failing',
            error: event.message,
          });
          return;
        case 'capi_forward_succeeded':
          if (!capiFailing) return;
          capiFailing = false;
          dispatch({
            kind: 'forwarding_error',
            occurredAt: event.at,
            server: 'CAPI',
            state: 'recovered',
            error: null,
          });
          return;
        case 'lapi_unreachable':
          dispatch({
            kind: 'lapi_error',
            occurredAt: event.at,
            server: event.server,
            state: 'failing',
            error: event.message,
          });
          return;
        case 'lapi_recovered':
          dispatch({
            kind: 'lapi_error',
            occurredAt: event.at,
            server: event.server,
            state: 'recovered',
            error: null,
          });
          return;
        case 'replication_failed':
          dispatch({
            kind: 'lapi_error',
            occurredAt: event.at,
            server: event.server,
            state: 'replication_failed',
            error: event.message,
          });
          return;
      }
    },

    async sendTest(name) {
      const rt = runtimes.get(name);
      if (!rt) return null;
      const t = now();
      if (rt.lastTestAt !== null && t - rt.lastTestAt < TEST_COOLDOWN_MS) {
        return {
          ok: false,
          throttled: true,
          message: 'A test was sent a few seconds ago, try again later',
        };
      }
      rt.lastTestAt = t;
      const payload =
        rt.target.type === 'slack'
          ? buildTestSlackPayload(dashboardUrl)
          : buildTestWebhookPayload(dashboardUrl, t);
      const result = await post(rt, JSON.stringify(payload));
      const at = now();
      rt.lastResult = {
        at,
        ok: result.ok,
        event: 'test',
        message: result.ok ? 'Delivered' : result.message,
        attempts: 1,
      };
      if (result.ok) {
        rt.lastSuccessAt = at;
        logger.info({ target: name }, 'Test notification delivered');
      } else {
        logger.warn({ target: name, error: result.message }, 'Test notification failed');
      }
      return { ok: result.ok, message: result.ok ? 'Delivered' : result.message };
    },

    getSnapshot() {
      return {
        enabled: runtimes.size > 0,
        dashboardUrl,
        targets: [...runtimes.values()].map((rt) => ({
          name: rt.target.name,
          type: rt.target.type,
          host: rt.host,
          events: [...rt.target.events],
          minInterval: rt.target.min_interval,
          minIntervalMs: rt.minIntervalMs,
          match: rt.target.events.includes('alert') ? rt.target.match : null,
          lastResult: rt.lastResult,
          lastSuccessAt: rt.lastSuccessAt,
          retrying: rt.retrying,
          queued: rt.outbox.length,
          buffered: [...rt.buffers.values()].reduce((sum, b) => sum + b.total, 0),
          dropped: rt.dropped,
        })),
      };
    },

    stop() {
      if (stopped) return;
      stopped = true;
      let unsent = 0;
      for (const rt of runtimes.values()) {
        for (const handle of rt.flushTimers.values()) timers.clearTimeout(handle);
        rt.flushTimers.clear();
        if (rt.retryTimer !== null) {
          timers.clearTimeout(rt.retryTimer);
          rt.retryTimer = null;
        }
        unsent += rt.outbox.length;
        for (const b of rt.buffers.values()) unsent += b.total > 0 ? 1 : 0;
        rt.outbox = [];
        rt.buffers.clear();
      }
      if (unsent > 0) {
        logger.warn({ messages: unsent }, 'Notification service stopped with unsent messages');
      }
    },
  };
}
