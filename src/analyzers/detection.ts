import net from 'net';
import type { Detection } from './config.js';
import type { LogEntry } from './sources/loki.js';

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
 * Parse a CIDR notation string and return network address and prefix length
 */
function parseCIDR(cidr: string): { ip: string; prefixLength: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;

  const ip = parts[0];
  const prefixLength = parseInt(parts[1], 10);

  if (!net.isIP(ip) || isNaN(prefixLength)) return null;

  const isIPv6 = net.isIPv6(ip);
  const maxPrefix = isIPv6 ? 128 : 32;

  if (prefixLength < 0 || prefixLength > maxPrefix) return null;

  return { ip, prefixLength };
}

/**
 * Convert an IP address to a BigInt for comparison
 */
function ipToBigInt(ip: string): bigint {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return BigInt((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]);
  } else if (net.isIPv6(ip)) {
    // Expand IPv6 to full form
    const expanded = expandIPv6(ip);
    const parts = expanded.split(':');
    let result = BigInt(0);
    for (const part of parts) {
      result = (result << BigInt(16)) + BigInt(parseInt(part, 16));
    }
    return result;
  }
  return BigInt(0);
}

/**
 * Expand an IPv6 address to full form (8 groups of 4 hex digits)
 */
function expandIPv6(ip: string): string {
  // Handle IPv4-mapped IPv6 (e.g., ::ffff:192.168.1.1)
  const colonParts = ip.split(':');
  const lastPart = colonParts[colonParts.length - 1];
  if (lastPart && lastPart.includes('.')) {
    const ipv4Parts = lastPart.split('.').map(Number);
    if (ipv4Parts.length === 4 && ipv4Parts.every((p) => p >= 0 && p <= 255)) {
      colonParts.pop();
      const hex1 = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16).padStart(4, '0');
      const hex2 = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16).padStart(4, '0');
      ip = colonParts.join(':') + ':' + hex1 + ':' + hex2;
    }
  }

  const parts = ip.split('::');
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    const full = [...left, ...middle, ...right];
    return full.map((p) => p.padStart(4, '0')).join(':');
  }

  return ip
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':');
}

/**
 * Check if an IP is in a CIDR range
 */
function isIPInCIDR(ip: string, cidr: string): boolean {
  const parsed = parseCIDR(cidr);
  if (!parsed) return false;

  const isIPv4 = net.isIPv4(ip);
  const isCIDRv4 = net.isIPv4(parsed.ip);

  // IP version must match CIDR version
  if (isIPv4 !== isCIDRv4) return false;

  const ipNum = ipToBigInt(ip);
  const cidrNum = ipToBigInt(parsed.ip);

  const bits = isIPv4 ? 32 : 128;
  const shift = BigInt(bits - parsed.prefixLength);
  const mask =
    shift >= BigInt(bits)
      ? BigInt(0)
      : ((BigInt(1) << BigInt(bits)) - BigInt(1)) ^ ((BigInt(1) << shift) - BigInt(1));

  return (ipNum & mask) === (cidrNum & mask);
}

/**
 * Check if an IP matches any entry in the whitelist
 * Whitelist can contain individual IPs or CIDR ranges
 */
export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  if (!net.isIP(ip) || whitelist.length === 0) {
    return false;
  }

  for (const entry of whitelist) {
    // Check if it's a CIDR range
    if (entry.includes('/')) {
      if (isIPInCIDR(ip, entry)) {
        return true;
      }
    } else {
      // Direct IP comparison
      if (ip === entry) {
        return true;
      }
    }
  }

  return false;
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

    // Track timestamps
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

  for (const [groupValue, group] of groups) {
    // Skip whitelisted IPs/ranges
    if (isWhitelisted(groupValue, whitelist)) {
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
