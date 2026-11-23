import {
  getMachineToken as defaultGetMachineToken,
  CROWDSIEVE_VERSION,
} from '../auth/machineToken.js';
import type { Config, LapiServer } from '../config/index.js';

/**
 * Health state of the integrations CrowdSieve depends on: CAPI forwarding and
 * the configured LAPI servers. Everything is kept in memory and resets at
 * restart. The state never contains secrets: only server names, URL hosts and
 * sanitized error messages leave this module.
 */

/** Interval between two LAPI health checks. */
export const LAPI_CHECK_INTERVAL_MS = 60_000;
/** Upper bound for a single health-check request, whatever `proxy.timeout_ms` is. */
export const LAPI_CHECK_MAX_TIMEOUT_MS = 10_000;
/** Sliding window for the "sent / failed" CAPI counters. */
export const CAPI_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 200;
const BUCKET_MS = 60_000;

// ---------------------------------------------------------------------------
// Events (other modules, e.g. notifications, can subscribe with onEvent)
// ---------------------------------------------------------------------------

export type StatusEvent =
  | { type: 'capi_forward_succeeded'; at: number; count: number }
  | { type: 'capi_forward_failed'; at: number; count: number; message: string }
  | { type: 'lapi_unreachable'; at: number; server: string; message: string }
  | { type: 'lapi_recovered'; at: number; server: string }
  | { type: 'replication_failed'; at: number; server: string; message: string };

export type StatusEventListener = (event: StatusEvent) => void;

// ---------------------------------------------------------------------------
// Snapshot shape (what GET /api/status returns)
// ---------------------------------------------------------------------------

export type CapiState = 'disabled' | 'idle' | 'ok' | 'failing';

export interface CapiStatus {
  enabled: boolean;
  state: CapiState;
  lastSuccessAt: number | null;
  lastError: { at: number; message: string } | null;
  /** Start of the current failure streak, null unless state is 'failing'. */
  failingSince: number | null;
  sent24h: number;
  failed24h: number;
}

export type MachineAuthState = 'not_configured' | 'ok' | 'failed' | 'unknown';

export interface LapiStatus {
  name: string;
  host: string;
  /** null until the first check completed. */
  reachable: boolean | null;
  responseTimeMs: number | null;
  error: string | null;
  checkedAt: number | null;
  /** Since when the server is unreachable (null when reachable/unknown). */
  unreachableSince: number | null;
  machineCredentials: boolean;
  machineAuth: MachineAuthState;
  manualBanAvailable: boolean;
  replication: {
    enabled: boolean;
    lastError: { at: number; message: string } | null;
    lastSuccessAt: number | null;
  };
}

export interface StatusProblem {
  kind: 'capi' | 'lapi';
  /** LAPI server name, for kind 'lapi'. */
  server?: string;
  since: number | null;
  message: string;
}

export interface StatusSnapshot {
  ok: boolean;
  problems: StatusProblem[];
  capi: CapiStatus;
  lapis: LapiStatus[];
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface StatusLogger {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

export interface StatusServiceOptions {
  /** Injectable clock (unix ms). */
  now?: () => number;
  /** Injectable fetch for the health checks. */
  fetchImpl?: typeof fetch;
  /** Injectable machine-JWT provider. */
  getMachineToken?: typeof defaultGetMachineToken;
  checkIntervalMs?: number;
}

export interface StatusService {
  recordCapiSuccess(count: number): void;
  recordCapiFailure(count: number, error: unknown): void;
  recordReplicationSuccess(server: string): void;
  recordReplicationFailure(server: string, error: unknown): void;
  /** Subscribe to status events. Returns an unsubscribe function. */
  onEvent(listener: StatusEventListener): () => void;
  /** Run one health check of every LAPI server. Never rejects. */
  checkLapis(): Promise<void>;
  /** Run a first check and schedule the periodic one. Idempotent. */
  start(): void;
  /** Stop the periodic check. */
  stop(): void;
  getSnapshot(): StatusSnapshot;
}

interface LapiState {
  reachable: boolean | null;
  responseTimeMs: number | null;
  error: string | null;
  checkedAt: number | null;
  unreachableSince: number | null;
  machineAuth: MachineAuthState;
  replicationError: { at: number; message: string } | null;
  replicationSuccessAt: number | null;
}

/** Host (with port) of a URL, without credentials, path or query. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Turn an arbitrary error into a short, secret-free message: credentials in
 * URLs, configured secrets and query strings are removed.
 */
export function sanitizeError(err: unknown, secrets: readonly string[] = []): string {
  let message: string;
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const code =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : undefined;
    message = code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      message = 'Request timed out';
    }
  } else {
    message = String(err);
  }
  // Drop URL userinfo and query strings, which may carry credentials.
  message = message.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1').replace(/(\w+:\/\/[^\s?]+)\?\S*/g, '$1');
  for (const secret of secrets) {
    if (secret.length >= 3) message = message.split(secret).join('***');
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export function createStatusService(
  config: Config,
  logger: StatusLogger,
  options: StatusServiceOptions = {}
): StatusService {
  const now = options.now ?? Date.now;
  const getToken = options.getMachineToken ?? defaultGetMachineToken;
  const intervalMs = options.checkIntervalMs ?? LAPI_CHECK_INTERVAL_MS;
  const servers: LapiServer[] = config.lapi_servers || [];
  const secrets = servers.flatMap((s) => [s.api_key, s.password].filter((v): v is string => !!v));
  const checkTimeoutMs = Math.min(config.proxy.timeout_ms, LAPI_CHECK_MAX_TIMEOUT_MS);

  const listeners = new Set<StatusEventListener>();
  const emit = (event: StatusEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err }, 'Status event listener failed');
      }
    }
  };

  // CAPI counters, per-minute buckets pruned to the 24 h window.
  const buckets = new Map<number, { sent: number; failed: number }>();
  let lastSuccessAt: number | null = null;
  let lastError: { at: number; message: string } | null = null;
  let failingSince: number | null = null;
  let attempted = false;

  const addToBucket = (field: 'sent' | 'failed', count: number): void => {
    const t = now();
    const key = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    const bucket = buckets.get(key) ?? { sent: 0, failed: 0 };
    bucket[field] += count;
    buckets.set(key, bucket);
    for (const k of buckets.keys()) {
      if (k <= t - CAPI_WINDOW_MS) buckets.delete(k);
    }
  };

  const lapiStates = new Map<string, LapiState>();
  for (const s of servers) {
    lapiStates.set(s.name, {
      reachable: null,
      responseTimeMs: null,
      error: null,
      checkedAt: null,
      unreachableSince: null,
      machineAuth: s.machine_id && s.password ? 'unknown' : 'not_configured',
      replicationError: null,
      replicationSuccessAt: null,
    });
  }

  const probe = async (
    server: LapiServer,
    path: string,
    headers: Record<string, string>
  ): Promise<Response> => {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    return doFetch(`${server.url}${path}`, {
      method: 'GET',
      headers: { 'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`, ...headers },
      signal: AbortSignal.timeout(checkTimeoutMs),
    });
  };

  async function checkServer(server: LapiServer): Promise<void> {
    const state = lapiStates.get(server.name);
    if (!state) return;
    const started = now();
    let reachable = false;
    let error: string | null = null;
    let machineAuth: MachineAuthState = state.machineAuth;

    try {
      let res: Response | null = null;
      if (server.machine_id && server.password) {
        const token = await getToken(server, checkTimeoutMs, logger);
        if (token) {
          machineAuth = 'ok';
          res = await probe(server, '/v1/heartbeat', { Authorization: `Bearer ${token}` });
        } else {
          machineAuth = 'failed';
        }
      }
      // No machine credentials (or machine login failed): a bouncer-key
      // request still tells whether the LAPI answers.
      if (!res) {
        res = await probe(server, '/v1/decisions?ip=127.0.0.1', { 'X-Api-Key': server.api_key });
      }
      // Drain the body so the connection can be reused.
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) {
        reachable = true;
      } else if (res.status === 401 || res.status === 403) {
        // The LAPI answered but rejected the credentials.
        error = `HTTP ${res.status} (credentials rejected)`;
        if (machineAuth === 'ok') machineAuth = 'failed';
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (err) {
      error = sanitizeError(err, secrets);
    }

    const finished = now();
    const wasUnreachable = state.reachable === false;
    state.checkedAt = finished;
    state.responseTimeMs = reachable ? Math.max(0, finished - started) : null;
    state.machineAuth = machineAuth;
    state.reachable = reachable;
    state.error = reachable ? null : error;

    if (reachable) {
      state.unreachableSince = null;
      if (wasUnreachable) emit({ type: 'lapi_recovered', at: finished, server: server.name });
    } else {
      if (!wasUnreachable) {
        state.unreachableSince = finished;
        emit({
          type: 'lapi_unreachable',
          at: finished,
          server: server.name,
          message: error ?? 'Unreachable',
        });
      }
      logger.warn({ server: server.name, error }, 'LAPI health check failed');
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function checkLapis(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await Promise.all(
        servers.map((s) =>
          checkServer(s).catch((err) => {
            logger.error({ server: s.name, err }, 'LAPI health check crashed');
          })
        )
      );
    } finally {
      running = false;
    }
  }

  return {
    recordCapiSuccess(count) {
      const at = now();
      attempted = true;
      lastSuccessAt = at;
      failingSince = null;
      addToBucket('sent', count);
      emit({ type: 'capi_forward_succeeded', at, count });
    },

    recordCapiFailure(count, error) {
      const at = now();
      const message = sanitizeError(error, secrets);
      attempted = true;
      lastError = { at, message };
      if (failingSince === null) failingSince = at;
      addToBucket('failed', count);
      emit({ type: 'capi_forward_failed', at, count, message });
    },

    recordReplicationSuccess(server) {
      const state = lapiStates.get(server);
      if (state) state.replicationSuccessAt = now();
    },

    recordReplicationFailure(server, error) {
      const at = now();
      const message = sanitizeError(error, secrets);
      const state = lapiStates.get(server);
      if (state) state.replicationError = { at, message };
      emit({ type: 'replication_failed', at, server, message });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    checkLapis,

    start() {
      if (timer) return;
      void checkLapis();
      timer = setInterval(() => void checkLapis(), intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    getSnapshot() {
      const t = now();
      let sent24h = 0;
      let failed24h = 0;
      for (const [k, b] of buckets) {
        if (k > t - CAPI_WINDOW_MS) {
          sent24h += b.sent;
          failed24h += b.failed;
        }
      }
      const enabled = config.proxy.forward_enabled;
      const state: CapiState = !enabled
        ? 'disabled'
        : failingSince !== null
          ? 'failing'
          : attempted
            ? 'ok'
            : 'idle';
      const capi: CapiStatus = {
        enabled,
        state,
        lastSuccessAt,
        lastError,
        failingSince: state === 'failing' ? failingSince : null,
        sent24h,
        failed24h,
      };

      const lapis: LapiStatus[] = servers.map((s) => {
        const st = lapiStates.get(s.name)!;
        const hasCredentials = Boolean(s.machine_id && s.password);
        return {
          name: s.name,
          host: urlHost(s.url),
          reachable: st.reachable,
          responseTimeMs: st.responseTimeMs,
          error: st.error,
          checkedAt: st.checkedAt,
          unreachableSince: st.unreachableSince,
          machineCredentials: hasCredentials,
          machineAuth: st.machineAuth,
          manualBanAvailable: hasCredentials && st.machineAuth !== 'failed',
          replication: {
            enabled: s.replicate_decisions,
            lastError: st.replicationError,
            lastSuccessAt: st.replicationSuccessAt,
          },
        };
      });

      const problems: StatusProblem[] = [];
      if (capi.state === 'failing') {
        problems.push({
          kind: 'capi',
          since: capi.failingSince,
          message: `CAPI forwarding is failing${capi.lastError ? `: ${capi.lastError.message}` : ''}`,
        });
      }
      for (const l of lapis) {
        if (l.reachable === false) {
          problems.push({
            kind: 'lapi',
            server: l.name,
            since: l.unreachableSince,
            message: `LAPI ${l.name} is unreachable${l.error ? `: ${l.error}` : ''}`,
          });
        }
      }

      return { ok: problems.length === 0, problems, capi, lapis, generatedAt: t };
    },
  };
}
