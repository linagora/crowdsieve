/**
 * Read the active decisions of a CrowdSec LAPI with its bouncer API key.
 *
 * `GET /v1/decisions` (bouncer auth) returns the active, non-simulated
 * decisions matching its query parameters, or `null` when there is none.
 * Filters understood by LAPI:
 *   - `ip=<ip|cidr>` / `range=<ip|cidr>`: decisions that contain the address
 *     or range; with `contains=false`, decisions contained in it;
 *   - `type=<type>` (exact), `origins=<o1,o2>` (exact, any of),
 *     `scenarios_containing=<s1,s2>` (case-insensitive substring, any of),
 *     `scope(s)=<scope>`, `value=<value>` (exact).
 * Each decision carries a `duration` relative to the time of the answer
 * (Go duration syntax, e.g. `3h56m24.5s`); `until` is usually absent.
 */
import type { LapiServer } from '../config/index.js';
import type { AppLogger } from '../logging.js';
import { CROWDSIEVE_VERSION } from '../auth/machineToken.js';

export interface LapiDecisionItem {
  id: number;
  uuid?: string;
  origin: string;
  type: string;
  scope: string;
  value: string;
  duration: string;
  scenario: string;
  until?: string;
}

export interface LapiDecisionQueryResult {
  decisions: LapiDecisionItem[];
  error?: string;
}

/** Origins of the community blocklists, shared by every LAPI enrolled in CAPI. */
export const SHARED_DECISION_ORIGINS: readonly string[] = Object.freeze(['CAPI', 'lists']);

/**
 * Origins of the decisions taken by this fleet: CrowdSec agents and AppSec,
 * cscli (including `cscli decisions import`), the CrowdSec console, and
 * CrowdSieve itself (manual bans, analyzers, replication). LAPI cannot exclude
 * origins, so leaving the community blocklists out means asking for these.
 */
export const LOCAL_DECISION_ORIGINS: readonly string[] = Object.freeze([
  'crowdsec',
  'cscli',
  'cscli-import',
  'console',
  'appsec',
  'crowdsieve',
  'crowdsieve-replication',
]);

export function isSharedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase();
  return SHARED_DECISION_ORIGINS.some((shared) => shared.toLowerCase() === lower);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Keep the fields the dashboard uses, coerced to strings, and drop entries
 * without a numeric id (they could not be deleted anyway).
 */
export function normalizeLapiDecision(raw: unknown): LapiDecisionItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'number' || !Number.isSafeInteger(d.id)) return null;
  const item: LapiDecisionItem = {
    id: d.id,
    origin: asString(d.origin),
    type: asString(d.type),
    scope: asString(d.scope),
    value: asString(d.value),
    duration: asString(d.duration),
    scenario: asString(d.scenario),
  };
  if (typeof d.uuid === 'string' && d.uuid) item.uuid = d.uuid;
  if (typeof d.until === 'string' && d.until) item.until = d.until;
  return item;
}

/**
 * Query `GET /v1/decisions` on one LAPI. Never throws: network errors,
 * timeouts, non-2xx answers and unexpected bodies are returned as `error`.
 */
export async function queryLapiDecisions(
  server: LapiServer,
  params: URLSearchParams,
  timeoutMs: number,
  logger?: AppLogger
): Promise<LapiDecisionQueryResult> {
  const query = params.toString();
  const url = `${server.url}/v1/decisions${query ? `?${query}` : ''}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-Api-Key': server.api_key,
        'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger?.warn(
        { server: server.name, status: response.status, error: errorBody },
        'LAPI returned error when querying decisions'
      );
      return { decisions: [], error: `LAPI error: ${response.status}` };
    }

    const body: unknown = await response.json();
    // LAPI answers `null` rather than `[]` when no decision matches.
    if (body === null) return { decisions: [] };
    if (!Array.isArray(body)) {
      logger?.warn({ server: server.name }, 'LAPI returned a non-array decision list');
      return { decisions: [], error: 'Unexpected LAPI response' };
    }
    const decisions: LapiDecisionItem[] = [];
    for (const raw of body) {
      const decision = normalizeLapiDecision(raw);
      if (decision) decisions.push(decision);
    }
    return { decisions };
  } catch (err) {
    logger?.warn({ server: server.name, err }, 'Failed to query LAPI for decisions');
    return {
      decisions: [],
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Run several queries against the same LAPI and merge their decisions by id
 * (first occurrence wins, order preserved). The first error, if any, is
 * reported along with the decisions of the queries that succeeded.
 */
export async function queryLapiDecisionsMerged(
  server: LapiServer,
  queries: URLSearchParams[],
  timeoutMs: number,
  logger?: AppLogger
): Promise<LapiDecisionQueryResult> {
  const results = await Promise.all(
    queries.map((params) => queryLapiDecisions(server, params, timeoutMs, logger))
  );
  const seen = new Set<number>();
  const decisions: LapiDecisionItem[] = [];
  for (const result of results) {
    for (const decision of result.decisions) {
      if (seen.has(decision.id)) continue;
      seen.add(decision.id);
      decisions.push(decision);
    }
  }
  const error = results.find((r) => r.error)?.error;
  return error ? { decisions, error } : { decisions };
}
