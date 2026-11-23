import { cidrMatches, parseCidr, parseIp, type ParsedCidr } from '../filters/cidr.js';

/**
 * Limits applied to each decision before it is replicated to the LAPIs.
 *
 * Even a trusted LAPI may forward a decision that should never be applied
 * everywhere (a typo'd `cscli decisions add -r 0.0.0.0/0`, a compromised
 * agent): replication writes into every target's decision base with
 * CrowdSieve's own credentials, so only plain, bounded IP remediations are
 * replicated.
 */

/** Decision types that may be replicated (compared case-insensitively). */
export const REPLICABLE_DECISION_TYPES: readonly string[] = Object.freeze(['ban', 'captcha']);

/** Shortest replicable IPv4 range prefix (a /16 is 65,536 addresses). */
export const MIN_REPLICABLE_IPV4_PREFIX = 16;

/** Shortest replicable IPv6 range prefix (a /32 is a typical ISP allocation). */
export const MIN_REPLICABLE_IPV6_PREFIX = 32;

/** Default for `replication.max_decision_duration`: 7 days. */
export const DEFAULT_MAX_DECISION_DURATION = '168h';

const GO_DURATION_UNITS_MS: Readonly<Record<string, number>> = Object.freeze({
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3, // U+00B5 MICRO SIGN
  μs: 1e-3, // U+03BC GREEK SMALL LETTER MU
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
});

const GO_DURATION_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/;
const GO_DURATION_PART_RE = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g;

/**
 * Parse a Go duration string (the format CrowdSec uses for decision
 * durations, e.g. "4h", "1h30m", "3h59m58.5s", "-12s") into milliseconds.
 * Returns null when the string is not a valid Go duration. "0" is accepted.
 */
export function parseGoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (value === '0' || value === '+0' || value === '-0') return 0;
  if (!GO_DURATION_RE.test(value)) return null;
  let total = 0;
  for (const match of value.matchAll(GO_DURATION_PART_RE)) {
    total += Number(match[1]) * GO_DURATION_UNITS_MS[match[2]];
  }
  if (!Number.isFinite(total)) return null;
  return value.startsWith('-') ? -total : total;
}

/** A decision as posted to a LAPI by the replication service. */
export interface ReplicatedDecision {
  type: string;
  scope: 'Ip' | 'Range';
  value: string;
  duration: string;
  origin: string;
  scenario: string;
  simulated: boolean;
}

export type DecisionCheck =
  { ok: true; decision: ReplicatedDecision; capped: boolean } | { ok: false; reason: string };

export interface DecisionLimits {
  /** Maximum duration, as a Go duration string (used as-is when capping). */
  maxDuration: string;
  /** `maxDuration` in milliseconds. */
  maxDurationMs: number;
}

// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d): a range there is an IPv4 range.
const IPV4_MAPPED: ParsedCidr = parseCidr('::ffff:0:0/96');

/** Why a range is too broad to be replicated, or null when it is acceptable. */
function rangeTooBroad(range: ParsedCidr): string | null {
  if (range.bits === 32) {
    return range.prefix < MIN_REPLICABLE_IPV4_PREFIX
      ? `IPv4 prefix shorter than /${MIN_REPLICABLE_IPV4_PREFIX}`
      : null;
  }
  if (range.prefix < MIN_REPLICABLE_IPV6_PREFIX) {
    return `IPv6 prefix shorter than /${MIN_REPLICABLE_IPV6_PREFIX}`;
  }
  // A range covering the whole IPv4-mapped block, or a mapped range wider
  // than an IPv4 /16, would ban IPv4 space through the IPv6 door.
  if (range.prefix <= 96 && cidrMatches(range, IPV4_MAPPED)) {
    return 'covers the IPv4-mapped IPv6 block';
  }
  if (
    range.prefix > 96 &&
    cidrMatches(IPV4_MAPPED, range) &&
    range.prefix - 96 < MIN_REPLICABLE_IPV4_PREFIX
  ) {
    return `IPv4-mapped prefix shorter than /${MIN_REPLICABLE_IPV4_PREFIX}`;
  }
  return null;
}

/**
 * Check a decision received through signals and build the copy to replicate.
 *
 * Only `Ip` and `Range` scopes and {@link REPLICABLE_DECISION_TYPES} are
 * kept; ranges broader than an IPv4 /16 or an IPv6 /32 are refused; the
 * duration must be a positive Go duration and is capped to
 * `limits.maxDuration`. Only the fields a LAPI needs are copied (no `id`,
 * `uuid` or `until` from the sender).
 */
export function prepareDecisionForReplication(
  decision: unknown,
  fallbackScenario: unknown,
  origin: string,
  limits: DecisionLimits
): DecisionCheck {
  if (!decision || typeof decision !== 'object') {
    return { ok: false, reason: 'not an object' };
  }
  const d = decision as Record<string, unknown>;

  const type = typeof d.type === 'string' ? d.type.trim().toLowerCase() : '';
  if (!REPLICABLE_DECISION_TYPES.includes(type)) {
    return { ok: false, reason: 'decision type not replicable' };
  }

  const scope = typeof d.scope === 'string' ? d.scope.trim().toLowerCase() : '';
  const value = typeof d.value === 'string' ? d.value.trim() : '';
  let canonicalScope: ReplicatedDecision['scope'];
  if (scope === 'ip') {
    if (parseIp(value) === null) {
      return { ok: false, reason: 'invalid IP value' };
    }
    canonicalScope = 'Ip';
  } else if (scope === 'range') {
    if (!value.includes('/')) {
      return { ok: false, reason: 'invalid range value' };
    }
    let range: ParsedCidr;
    try {
      range = parseCidr(value);
    } catch {
      return { ok: false, reason: 'invalid range value' };
    }
    const tooBroad = rangeTooBroad(range);
    if (tooBroad) {
      return { ok: false, reason: `range too broad (${tooBroad})` };
    }
    canonicalScope = 'Range';
  } else {
    return { ok: false, reason: 'decision scope not replicable' };
  }

  const durationMs = parseGoDuration(d.duration);
  if (durationMs === null) {
    return { ok: false, reason: 'invalid duration' };
  }
  if (durationMs <= 0) {
    return { ok: false, reason: 'non-positive duration' };
  }
  const capped = durationMs > limits.maxDurationMs;

  const scenario =
    typeof d.scenario === 'string'
      ? d.scenario
      : typeof fallbackScenario === 'string'
        ? fallbackScenario
        : '';

  return {
    ok: true,
    capped,
    decision: {
      type,
      scope: canonicalScope,
      value,
      duration: capped ? limits.maxDuration : (d.duration as string),
      origin,
      scenario,
      simulated: d.simulated === true,
    },
  };
}
