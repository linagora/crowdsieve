/**
 * Pure helpers of the Manual Ban form: target list parsing, custom duration,
 * fan-out of one request per target and result summary.
 */

export type BanType = 'ban' | 'captcha';

export const BAN_TYPES: ReadonlyArray<{ value: BanType; label: string }> = [
  { value: 'ban', label: 'Ban' },
  { value: 'captcha', label: 'Captcha' },
];

/** Most targets accepted in one submission. */
export const MAX_BAN_TARGETS = 100;
/** Ban requests sent at the same time. */
export const BAN_CONCURRENCY = 5;

// --- Targets ----------------------------------------------------------------

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

export function isIPv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  // The WHATWG URL parser validates IPv6 hosts (including an embedded IPv4).
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/** Whether `value` is an IP address or a CIDR range the ban API accepts. */
export function isIpOrCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return isIPv4(value) || isIPv6(value);
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (isIPv4(address)) return bits <= 32;
  if (isIPv6(address)) return bits <= 128;
  return false;
}

export interface ParsedBanTargets {
  /** Valid, de-duplicated values, in input order. */
  valid: string[];
  /** Invalid values, de-duplicated, in input order. */
  invalid: string[];
}

/** Split a list of IPs / ranges separated by new lines, commas, semicolons or spaces. */
export function parseBanTargets(input: string): ParsedBanTargets {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of input.split(/[\s,;]+/)) {
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (isIpOrCidr(token) ? valid : invalid).push(token);
  }
  return { valid, invalid };
}

/** Error shown under the target field, or null when the list can be submitted. */
export function banTargetsError(targets: ParsedBanTargets): string | null {
  if (targets.invalid.length > 0) {
    const n = targets.invalid.length;
    return `${n} invalid ${n === 1 ? 'entry' : 'entries'}: ${targets.invalid.join(', ')}`;
  }
  if (targets.valid.length > MAX_BAN_TARGETS) {
    return `At most ${MAX_BAN_TARGETS} IPs per ban`;
  }
  return null;
}

/** Submit button label: "Ban", "Ban 15 IPs", "Apply captcha to 15 IPs". */
export function banButtonLabel(type: BanType, count: number): string {
  if (type === 'captcha') {
    return count > 1 ? `Apply captcha to ${count} IPs` : 'Apply captcha';
  }
  return count > 1 ? `Ban ${count} IPs` : 'Ban';
}

// --- Duration ---------------------------------------------------------------

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const DURATION_UNITS: ReadonlyArray<{ value: DurationUnit; label: string }> = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

export const DURATION_RANGE_ERROR = 'Duration must be between 1 minute and 365 days';
const MAX_DURATION_MINUTES = 365 * 24 * 60;
const UNIT_MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

/**
 * API duration of a custom amount (`90m`, `2h`; days are converted to hours),
 * or an error when it is not a whole number between 1 minute and 365 days.
 */
export function customDuration(
  amount: string,
  unit: DurationUnit
): { duration: string } | { error: string } {
  const trimmed = amount.trim();
  if (trimmed === '' || /^-\d/.test(trimmed)) return { error: DURATION_RANGE_ERROR };
  if (!/^\d+$/.test(trimmed)) return { error: 'Enter a whole number' };
  const n = Number(trimmed);
  if (n < 1 || n * UNIT_MINUTES[unit] > MAX_DURATION_MINUTES) {
    return { error: DURATION_RANGE_ERROR };
  }
  if (unit === 'minutes') return { duration: `${n}m` };
  if (unit === 'hours') return { duration: `${n}h` };
  return { duration: `${n * 24}h` };
}

// --- Fan-out ----------------------------------------------------------------

/**
 * Run `worker` on every item with at most `limit` calls in flight. Results
 * keep the order of `items`. `worker` is expected not to throw.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// --- Result summary ---------------------------------------------------------

export interface BanAttempt {
  target: string;
  server: string;
  success: boolean;
  message: string;
}

export interface BanSummary {
  success: boolean;
  message: string;
  /** Targets that failed on at least one server, kept for a retry. */
  failedTargets: string[];
  /** One line per failed target: "203.0.113.9 — LAPI error 500". */
  failures: string[];
}

/**
 * Summarise one attempt per (target, server). A target counts as applied
 * when it succeeded on every selected server.
 */
export function summarizeBanAttempts(
  attempts: readonly BanAttempt[],
  servers: readonly string[],
  type: BanType
): BanSummary {
  const byTarget = new Map<string, BanAttempt[]>();
  for (const attempt of attempts) {
    const list = byTarget.get(attempt.target) ?? [];
    list.push(attempt);
    byTarget.set(attempt.target, list);
  }

  const failedTargets: string[] = [];
  const failures: string[] = [];
  for (const [target, list] of byTarget) {
    const failed = list.filter((a) => !a.success);
    if (failed.length === 0) continue;
    failedTargets.push(target);
    const reasons = failed.map((a) =>
      servers.length > 1 ? `${a.server}: ${a.message}` : a.message
    );
    failures.push(`${target} — ${reasons.join('; ')}`);
  }

  const applied = byTarget.size - failedTargets.length;
  const where = servers.length > 1 ? `on all ${servers.length} servers` : `on ${servers[0] ?? ''}`;
  const done = (what: string | number) =>
    type === 'captcha'
      ? `Captcha applied to ${typeof what === 'number' ? `${what} ${what === 1 ? 'IP' : 'IPs'}` : what}`
      : `${what} banned`;

  if (failedTargets.length === 0) {
    if (byTarget.size === 1) {
      // Single target on one server: keep the API message ("198.51.100.240: captcha for 2h").
      if (servers.length === 1 && attempts[0]?.message) {
        return { success: true, message: attempts[0].message, failedTargets, failures };
      }
      return {
        success: true,
        message: `${done(attempts[0]?.target ?? '')} ${where}`,
        failedTargets,
        failures,
      };
    }
    return { success: true, message: `${done(applied)} ${where}`, failedTargets, failures };
  }

  const failedPart =
    failures.length === 1 ? `1 failed: ${failures[0]}` : `${failedTargets.length} failed`;
  return { success: false, message: `${done(applied)}, ${failedPart}`, failedTargets, failures };
}
