import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  loadAnalyzersFromDirectory,
  parseAnalyzersGlobalConfig,
  parseDuration,
  resolveSource,
  type AnalyzerConfig,
  type Source,
} from '../src/analyzers/config.js';
import { analyze, isWhitelisted } from '../src/analyzers/detection.js';
import type { LogEntry } from '../src/analyzers/sources/loki.js';

const TEST_DIR = join(process.cwd(), 'tests', 'fixtures', 'analyzers.d');

describe('Analyzer Config', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    delete process.env.TEST_GRAFANA_TOKEN;
  });

  describe('loadAnalyzersFromDirectory', () => {
    it('should return empty array for non-existent directory', () => {
      const result = loadAnalyzersFromDirectory('/nonexistent/path');
      expect(result.analyzers).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should load valid analyzer config', () => {
      writeFileSync(
        join(TEST_DIR, 'test-analyzer.yaml'),
        `id: test-analyzer
name: Test Analyzer
enabled: true
version: "1.0.0"

schedule:
  interval: "1h"
  lookback: "1h"

source:
  ref: "grafana-test"
  query: '{app="test"}'
  max_lines: 1000

extraction:
  format: json
  fields:
    source_ip: "remote_ip"
    username: "user"

detection:
  groupby: source_ip
  distinct: username
  threshold: 5
  operator: ">="

decision:
  type: ban
  duration: "24h"
  scope: ip
  scenario: "test/analyzer"
  reason: "Test detection"

targets:
  - all
`
      );

      const result = loadAnalyzersFromDirectory(TEST_DIR);

      expect(result.analyzers).toHaveLength(1);
      expect(result.errors).toEqual([]);
      expect(result.analyzers[0]).toMatchObject({
        id: 'test-analyzer',
        name: 'Test Analyzer',
        enabled: true,
        schedule: { interval: '1h', lookback: '1h' },
        detection: { groupby: 'source_ip', distinct: 'username', threshold: 5 },
      });
    });

    it('should report errors for invalid analyzer config', () => {
      writeFileSync(
        join(TEST_DIR, 'invalid.yaml'),
        `id: invalid
name: Invalid
# Missing required fields
`
      );

      const result = loadAnalyzersFromDirectory(TEST_DIR);

      expect(result.analyzers).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe('invalid.yaml');
    });

    it('should ignore files starting with underscore or dot', () => {
      writeFileSync(
        join(TEST_DIR, '_disabled.yaml'),
        `id: disabled
name: Disabled
`
      );
      writeFileSync(
        join(TEST_DIR, '.hidden.yaml'),
        `id: hidden
name: Hidden
`
      );

      const result = loadAnalyzersFromDirectory(TEST_DIR);

      expect(result.analyzers).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should interpolate environment variables', () => {
      process.env.TEST_GRAFANA_TOKEN = 'secret-token';

      writeFileSync(
        join(TEST_DIR, 'env-test.yaml'),
        `id: env-test
name: Env Test
enabled: true

schedule:
  interval: "1h"
  lookback: "1h"

source:
  ref: "grafana-\${TEST_GRAFANA_TOKEN}"
  query: '{app="test"}'

extraction:
  format: json
  fields:
    ip: "source_ip"

detection:
  groupby: ip
  threshold: 10

decision:
  type: ban
  duration: "1h"
  scenario: "test/env"
  reason: "Test"
`
      );

      const result = loadAnalyzersFromDirectory(TEST_DIR);

      expect(result.analyzers).toHaveLength(1);
      expect(result.analyzers[0].source.ref).toBe('grafana-secret-token');
    });
  });

  describe('parseDuration', () => {
    it('should parse seconds', () => {
      expect(parseDuration('30s')).toBe(30000);
    });

    it('should parse minutes', () => {
      expect(parseDuration('5m')).toBe(300000);
    });

    it('should parse hours', () => {
      expect(parseDuration('3h')).toBe(10800000);
    });

    it('should parse days', () => {
      expect(parseDuration('1d')).toBe(86400000);
    });

    it('should throw for invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow('Invalid duration format');
      expect(() => parseDuration('10x')).toThrow('Invalid duration format');
      expect(() => parseDuration('')).toThrow('Invalid duration format');
    });
  });

  describe('parseAnalyzersGlobalConfig', () => {
    it('should parse empty config with defaults', () => {
      const config = parseAnalyzersGlobalConfig({});

      expect(config.enabled).toBe(false);
      expect(config.config_dir).toBe('./config/analyzers.d');
      expect(config.default_interval).toBe('3h');
      expect(config.whitelist).toEqual([]);
      expect(config.sources).toEqual({});
    });

    it('should parse full config', () => {
      const config = parseAnalyzersGlobalConfig({
        enabled: true,
        config_dir: './custom/analyzers',
        whitelist: ['10.0.0.0/8', '192.168.1.1'],
        sources: {
          'grafana-prod': {
            type: 'loki',
            grafana_url: 'https://grafana.example.com',
            token: 'test-token',
            datasource_uid: 'loki-1',
          },
        },
      });

      expect(config.enabled).toBe(true);
      expect(config.config_dir).toBe('./custom/analyzers');
      expect(config.whitelist).toEqual(['10.0.0.0/8', '192.168.1.1']);
      expect(config.sources['grafana-prod']).toBeDefined();
    });
  });

  describe('resolveSource', () => {
    it('should resolve existing source', () => {
      const sources: Record<string, Source> = {
        'grafana-prod': {
          type: 'loki',
          grafana_url: 'https://grafana.example.com',
          token: 'token',
          datasource_uid: 'loki-1',
        },
      };

      const result = resolveSource('grafana-prod', sources);
      expect(result).toEqual(sources['grafana-prod']);
    });

    it('should return null for non-existent source', () => {
      const result = resolveSource('non-existent', {});
      expect(result).toBeNull();
    });
  });
});

describe('Whitelist and CIDR matching', () => {
  describe('isWhitelisted', () => {
    it('should match exact IPv4 address', () => {
      expect(isWhitelisted('192.168.1.1', ['192.168.1.1'])).toBe(true);
      expect(isWhitelisted('192.168.1.2', ['192.168.1.1'])).toBe(false);
    });

    it('should match IPv4 CIDR range', () => {
      expect(isWhitelisted('10.0.0.1', ['10.0.0.0/8'])).toBe(true);
      expect(isWhitelisted('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
      expect(isWhitelisted('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    });

    it('should match IPv4 /16 CIDR', () => {
      expect(isWhitelisted('172.16.0.1', ['172.16.0.0/12'])).toBe(true);
      expect(isWhitelisted('172.31.255.255', ['172.16.0.0/12'])).toBe(true);
      expect(isWhitelisted('172.32.0.1', ['172.16.0.0/12'])).toBe(false);
    });

    it('should match IPv4 /24 CIDR', () => {
      expect(isWhitelisted('192.168.1.1', ['192.168.1.0/24'])).toBe(true);
      expect(isWhitelisted('192.168.1.254', ['192.168.1.0/24'])).toBe(true);
      expect(isWhitelisted('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
    });

    it('should match exact IPv6 address', () => {
      expect(isWhitelisted('::1', ['::1'])).toBe(true);
      expect(isWhitelisted('::2', ['::1'])).toBe(false);
    });

    it('should match IPv6 CIDR range', () => {
      expect(isWhitelisted('fc00::1', ['fc00::/7'])).toBe(true);
      expect(isWhitelisted('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', ['fc00::/7'])).toBe(true);
      expect(isWhitelisted('2001:db8::1', ['fc00::/7'])).toBe(false);
    });

    it('should match against multiple whitelist entries', () => {
      const whitelist = ['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'];
      expect(isWhitelisted('10.1.2.3', whitelist)).toBe(true);
      expect(isWhitelisted('192.168.100.1', whitelist)).toBe(true);
      expect(isWhitelisted('172.20.0.1', whitelist)).toBe(true);
      expect(isWhitelisted('8.8.8.8', whitelist)).toBe(false);
    });

    it('should return false for invalid IP', () => {
      expect(isWhitelisted('not-an-ip', ['10.0.0.0/8'])).toBe(false);
      expect(isWhitelisted('', ['10.0.0.0/8'])).toBe(false);
    });

    it('should return false for empty whitelist', () => {
      expect(isWhitelisted('10.0.0.1', [])).toBe(false);
    });

    it('should not match IPv4 against IPv6 CIDR', () => {
      expect(isWhitelisted('10.0.0.1', ['fc00::/7'])).toBe(false);
    });

    it('should not match IPv6 against IPv4 CIDR', () => {
      expect(isWhitelisted('::1', ['10.0.0.0/8'])).toBe(false);
    });
  });
});

describe('Detection Logic', () => {
  describe('analyze', () => {
    const createLogEntry = (
      sourceIp: string,
      username: string,
      timestamp?: string
    ): LogEntry => ({
      raw: JSON.stringify({ source_ip: sourceIp, username }),
      timestamp: timestamp || new Date().toISOString(),
      fields: { source_ip: sourceIp, username },
    });

    it('should group by specified field and count distinct values', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user2'),
        createLogEntry('1.2.3.4', 'user3'),
        createLogEntry('1.2.3.4', 'user1'), // duplicate
        createLogEntry('5.6.7.8', 'userA'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 2, operator: '>=' },
        []
      );

      expect(result.totalLogsAnalyzed).toBe(5);
      expect(result.totalGroups).toBe(2);
      expect(result.alertCount).toBe(1); // Only 1.2.3.4 has >= 2 distinct usernames
      expect(result.alerts[0].groupValue).toBe('1.2.3.4');
      expect(result.alerts[0].distinctCount).toBe(3);
      expect(result.alerts[0].totalCount).toBe(4);
    });

    it('should respect threshold and operator', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user2'),
        createLogEntry('1.2.3.4', 'user3'),
        createLogEntry('5.6.7.8', 'userA'),
        createLogEntry('5.6.7.8', 'userB'),
      ];

      // Threshold 3, should only match 1.2.3.4
      const result1 = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 3, operator: '>=' },
        []
      );
      expect(result1.alertCount).toBe(1);
      expect(result1.alerts[0].groupValue).toBe('1.2.3.4');

      // Threshold 2, should match both
      const result2 = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 2, operator: '>=' },
        []
      );
      expect(result2.alertCount).toBe(2);
    });

    it('should filter out whitelisted IPs', () => {
      const logs: LogEntry[] = [
        createLogEntry('10.0.0.1', 'user1'),
        createLogEntry('10.0.0.1', 'user2'),
        createLogEntry('10.0.0.1', 'user3'),
        createLogEntry('8.8.8.8', 'userA'),
        createLogEntry('8.8.8.8', 'userB'),
        createLogEntry('8.8.8.8', 'userC'),
      ];

      const whitelist = ['10.0.0.0/8'];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 2, operator: '>=' },
        whitelist
      );

      expect(result.alertCount).toBe(1);
      expect(result.whitelistedCount).toBe(1);
      expect(result.alerts[0].groupValue).toBe('8.8.8.8');
    });

    it('should count total entries when distinct is not specified', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('5.6.7.8', 'userA'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', threshold: 2, operator: '>=' },
        []
      );

      expect(result.alertCount).toBe(1);
      expect(result.alerts[0].groupValue).toBe('1.2.3.4');
      expect(result.alerts[0].totalCount).toBe(3);
    });

    it('should track first and last seen timestamps', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1', '2024-01-01T10:00:00Z'),
        createLogEntry('1.2.3.4', 'user2', '2024-01-01T12:00:00Z'),
        createLogEntry('1.2.3.4', 'user3', '2024-01-01T08:00:00Z'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 1, operator: '>=' },
        []
      );

      expect(result.alerts[0].firstSeen).toBe('2024-01-01T08:00:00Z');
      expect(result.alerts[0].lastSeen).toBe('2024-01-01T12:00:00Z');
    });

    it('should support different comparison operators', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user2'),
        createLogEntry('5.6.7.8', 'userA'),
        createLogEntry('5.6.7.8', 'userB'),
        createLogEntry('5.6.7.8', 'userC'),
      ];

      // Greater than
      const resultGt = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 2, operator: '>' },
        []
      );
      expect(resultGt.alertCount).toBe(1);
      expect(resultGt.alerts[0].groupValue).toBe('5.6.7.8');

      // Equal
      const resultEq = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 2, operator: '==' },
        []
      );
      expect(resultEq.alertCount).toBe(1);
      expect(resultEq.alerts[0].groupValue).toBe('1.2.3.4');

      // Less than
      const resultLt = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 3, operator: '<' },
        []
      );
      expect(resultLt.alertCount).toBe(1);
      expect(resultLt.alerts[0].groupValue).toBe('1.2.3.4');
    });

    it('should skip logs without groupby field', () => {
      const logs: LogEntry[] = [
        { raw: '{}', timestamp: new Date().toISOString(), fields: { username: 'user1' } },
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user2'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 1, operator: '>=' },
        []
      );

      expect(result.totalLogsAnalyzed).toBe(3);
      expect(result.totalGroups).toBe(1);
    });

    it('should return empty alerts when no threshold exceeded', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('5.6.7.8', 'userA'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 5, operator: '>=' },
        []
      );

      expect(result.alertCount).toBe(0);
      expect(result.alerts).toEqual([]);
    });

    it('should sort alerts by distinct count descending', () => {
      const logs: LogEntry[] = [
        createLogEntry('1.2.3.4', 'user1'),
        createLogEntry('1.2.3.4', 'user2'),
        createLogEntry('5.6.7.8', 'userA'),
        createLogEntry('5.6.7.8', 'userB'),
        createLogEntry('5.6.7.8', 'userC'),
        createLogEntry('5.6.7.8', 'userD'),
      ];

      const result = analyze(
        logs,
        { groupby: 'source_ip', distinct: 'username', threshold: 1, operator: '>=' },
        []
      );

      expect(result.alerts[0].groupValue).toBe('5.6.7.8'); // 4 distinct
      expect(result.alerts[1].groupValue).toBe('1.2.3.4'); // 2 distinct
    });
  });
});
