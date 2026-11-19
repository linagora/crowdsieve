import type { Detection } from './config.js';
import type { LogEntry } from './sources/loki.js';
import { cidrMatches, parseCidr, parseIp, type ParsedCidr } from '../filters/cidr.js';

export interface DetectionResult {
  groupValue: string; // e.g., the IP address
  distinctCount: number; // Count of distinct values (e.g., usernames)
  totalCount: number; // Total number of log entries
  firstSeen: string;
  lastSeen: string;
  distinctValues: string[]; // The actual distinct values (for debugging/display)
}

export interface AnalysisResult {
  alerts: DetectionResult[];
  totalLogsAnalyzed: number;
  totalGroups: number;
  alertCount: number;
  whitelistedCount: number; // Number of groups skipped due to whitelist
}

/**
 * Parse whitelist entries (bare IPs or CIDR ranges) into ranges for
 * {@link isWhitelistedIn}. A bare address is a host route (/32 or /128).
 *
 * Invalid entries are dropped rather than failing the analyzer run, and so
 * are entries that are not strings. An entry with a prefix and surrounding
 * whitespace is dropped too, as it always was (only bare entries used to be
 * trimmed); config validation rejects all of these.
 */
function parseWhitelist(whitelist: readonly unknown[]): ParsedCidr[] {
  const ranges: ParsedCidr[] = [];
  for (const entry of whitelist) {
    if (typeof entry !== 'string') {
      continue;
    }
    if (entry.includes('/') && entry !== entry.trim()) {
      continue;
    }
    try {
      ranges.push(parseCidr(entry));
    } catch {
      // Invalid whitelist entry: ignore it.
    }
  }
  return ranges;
}

/**
 * Check a group value against parsed whitelist ranges. A value that is not an
 * IP is never whitelisted. Families never cross: an IPv4-mapped address such
 * as "::ffff:10.0.0.1" stays IPv6 and does not match "10.0.0.0/8".
 */
function isWhitelistedIn(ip: string, ranges: readonly ParsedCidr[]): boolean {
  if (ranges.length === 0) {
    return false;
  }
  const parsed = parseIp(ip);
  if (parsed === null) {
    return false;
  }
  for (const range of ranges) {
    if (cidrMatches(range, parsed)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an IP matches any entry in the whitelist
 * Whitelist can contain individual IPs or CIDR ranges
 *
 * This parses the whole whitelist on every call; {@link analyze} parses it
 * once per run instead.
 */
export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  return isWhitelistedIn(ip, parseWhitelist(whitelist));
}

/**
 * Compare a value against a threshold using the specified operator
 */
function compareWithThreshold(value: number, threshold: number, operator: string): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
    default:
      return value >= threshold;
  }
}

/**
 * Analyze logs according to detection configuration
 *
 * Groups logs by the specified field, counts distinct values of another field,
 * and returns results that exceed the threshold.
 *
 * Example:
 * - groupby: "source_ip"
 * - distinct: "username"
 * - threshold: 6
 * - operator: ">="
 *
 * This would flag IPs that attempted 6+ different usernames.
 *
 * @param logs - Log entries to analyze
 * @param detection - Detection configuration
 * @param whitelist - Optional list of IPs/CIDRs to ignore
 */
export function analyze(
  logs: LogEntry[],
  detection: Detection,
  whitelist: string[] = []
): AnalysisResult {
  const groups = new Map<
    string,
    {
      values: Set<string>;
      count: number;
      firstSeen: string;
      lastSeen: string;
    }
  >();

  // Group logs by the specified field
  for (const log of logs) {
    const groupValue = String(log.fields[detection.groupby] ?? '');
    if (!groupValue) {
      continue; // Skip logs without a group value
    }

    let group = groups.get(groupValue);
    if (!group) {
      group = {
        values: new Set(),
        count: 0,
        firstSeen: log.timestamp,
        lastSeen: log.timestamp,
      };
      groups.set(groupValue, group);
    }

    group.count++;

    // Track timestamps (string comparison works because timestamps are ISO 8601 format,
    // which is lexicographically sortable: "2024-01-01T00:00:00Z" < "2024-01-02T00:00:00Z")
    if (log.timestamp < group.firstSeen) {
      group.firstSeen = log.timestamp;
    }
    if (log.timestamp > group.lastSeen) {
      group.lastSeen = log.timestamp;
    }

    // Add distinct value if configured
    if (detection.distinct) {
      const distinctValue = String(log.fields[detection.distinct] ?? '');
      if (distinctValue) {
        group.values.add(distinctValue);
      }
    }
  }

  // Build results for groups that exceed the threshold
  const alerts: DetectionResult[] = [];
  let whitelistedCount = 0;
  // The whitelist is constant for the run: parse it once, not once per group.
  const whitelistRanges = parseWhitelist(whitelist);

  for (const [groupValue, group] of groups) {
    // Skip whitelisted IPs/ranges
    if (isWhitelistedIn(groupValue, whitelistRanges)) {
      whitelistedCount++;
      continue;
    }

    // Determine the count to compare (distinct values or total count)
    const countToCompare = detection.distinct ? group.values.size : group.count;

    if (compareWithThreshold(countToCompare, detection.threshold, detection.operator)) {
      alerts.push({
        groupValue,
        distinctCount: group.values.size,
        totalCount: group.count,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
        distinctValues: Array.from(group.values).slice(0, 20), // Limit for display
      });
    }
  }

  // Sort by distinct count descending
  alerts.sort((a, b) => b.distinctCount - a.distinctCount);

  return {
    alerts,
    totalLogsAnalyzed: logs.length,
    totalGroups: groups.size,
    alertCount: alerts.length,
    whitelistedCount,
  };
}
