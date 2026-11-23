/**
 * Expiry of a LAPI decision.
 *
 * LAPI's `GET /v1/decisions` gives each decision a `duration` relative to the
 * time of its answer, in Go duration syntax (`3h56m24.5s`, `-1.2ms`, `0s`),
 * and usually no `until`. The expiry date is `until` when present, else the
 * time the answer was received plus the duration.
 */

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3, // U+00B5 MICRO SIGN
  μs: 1e-3, // U+03BC GREEK SMALL LETTER MU
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

const GO_DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy;

/**
 * Parse a Go duration (`time.Duration.String()` / `time.ParseDuration`
 * syntax) into milliseconds. Returns null when the text is not a duration.
 */
export function parseGoDuration(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  if (s === '0') return 0;
  if (!s) return null;

  GO_DURATION_PART.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = GO_DURATION_PART.exec(s)) !== null) {
    total += parseFloat(match[1]) * UNIT_MS[match[2]];
    consumed = GO_DURATION_PART.lastIndex;
  }
  if (consumed === 0 || consumed !== s.length) return null;
  return sign * total;
}

export type DecisionExpiry =
  /** The decision expires (or expired) at `date`. */
  | { kind: 'at'; date: Date }
  /** No `until` and no duration: the decision does not expire. */
  | { kind: 'never' }
  /** Neither `until` nor `duration` could be understood. */
  | { kind: 'unknown' };

/**
 * Compute when a decision expires.
 *
 * @param decision   the decision as returned by LAPI (through the proxy)
 * @param answeredAt time the LAPI answer was received (ms since epoch or Date)
 */
export function decisionExpiry(
  decision: { until?: string | null; duration?: string | null },
  answeredAt: number | Date
): DecisionExpiry {
  if (decision.until) {
    const until = new Date(decision.until);
    if (!isNaN(until.getTime())) return { kind: 'at', date: until };
  }
  const duration = decision.duration?.trim();
  if (!duration) return { kind: 'never' };
  const ms = parseGoDuration(duration);
  if (ms === null) return { kind: 'unknown' };
  const base = answeredAt instanceof Date ? answeredAt.getTime() : answeredAt;
  return { kind: 'at', date: new Date(base + ms) };
}

/**
 * Milliseconds until the expiry, for sorting: negative when already expired,
 * +Infinity for a decision that never expires or whose expiry is unknown.
 */
export function expiryRemainingMs(expiry: DecisionExpiry, now: number | Date): number {
  if (expiry.kind !== 'at') return Number.POSITIVE_INFINITY;
  return expiry.date.getTime() - (now instanceof Date ? now.getTime() : now);
}

/**
 * Short human rendering of a remaining time: `2d 4h`, `3h 56m`, `12m`, `45s`.
 * Returns null for a time that is already over (<= 0).
 */
export function formatRemaining(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Remaining time phrase: `in 3h 56m`, or `expired`.
 */
export function formatRemainingPhrase(expiry: DecisionExpiry, now: number | Date): string | null {
  if (expiry.kind !== 'at') return null;
  const remaining = formatRemaining(expiryRemainingMs(expiry, now));
  return remaining ? `in ${remaining}` : 'expired';
}

const DEFAULT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
};

/**
 * Expiry date in the given (default: browser) locale and time zone, e.g.
 * `11 Nov 2026, 23:04`; `never` or `unknown` when there is no date.
 */
export function formatExpiryDate(
  expiry: DecisionExpiry,
  locale?: string | string[],
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_FORMAT
): string {
  if (expiry.kind === 'never') return 'never';
  if (expiry.kind === 'unknown') return 'unknown';
  return new Intl.DateTimeFormat(locale, options).format(expiry.date);
}

/**
 * Full expiry text: `11 Nov 2026, 23:04 (in 3h 56m)`, `11 Nov 2026, 23:04
 * (expired)`, `never` or `unknown`.
 */
export function formatExpiry(
  expiry: DecisionExpiry,
  now: number | Date,
  locale?: string | string[],
  options?: Intl.DateTimeFormatOptions
): string {
  const date = formatExpiryDate(expiry, locale, options);
  const phrase = formatRemainingPhrase(expiry, now);
  return phrase ? `${date} (${phrase})` : date;
}
