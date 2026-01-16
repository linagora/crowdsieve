/**
 * Decision Statistics Tests (SQLite)
 *
 * Tests for the getDecisionStats storage method
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getDatabaseContext } from '../src/db/index.js';
import { createStorage } from '../src/storage/index.js';
import type { Alert } from '../src/models/alert.js';
import type { Config } from '../src/config/index.js';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Create a silent logger for tests
const logger = pino({ level: 'silent' });

// Test database path
const TEST_DB_PATH = './data/test-decision-stats.db';

// Create test config for SQLite
function createTestConfig(): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
      auth: { type: 'none' },
    },
    storage: {
      type: 'sqlite',
      path: TEST_DB_PATH,
      retention_days: 30,
    },
    lapi_servers: [],
    filters: [],
    filter_errors: [],
    geoip: { enabled: false },
    ipinfo: { enabled: false },
    dashboard: { enabled: false },
    cleanup: { enabled: false, interval_hours: 24 },
  };
}

// Create a test alert with decisions
function createTestAlert(overrides: Partial<Alert> = {}): Alert {
  const now = new Date().toISOString();
  return {
    uuid: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    machine_id: 'test-machine',
    scenario: 'crowdsecurity/test-scenario',
    scenario_hash: 'abc123',
    scenario_version: '1.0.0',
    message: 'Test alert message',
    events_count: 5,
    capacity: 0,
    leakspeed: '1m',
    start_at: now,
    stop_at: now,
    created_at: now,
    simulated: false,
    remediation: true,
    source: {
      scope: 'ip',
      value: '192.168.1.100',
      ip: '192.168.1.100',
      cn: 'US',
    },
    decisions: [
      {
        uuid: `decision-${Date.now()}`,
        origin: 'crowdsec',
        type: 'ban',
        scope: 'ip',
        value: '192.168.1.100',
        duration: '4h',
        scenario: 'crowdsecurity/test-scenario',
        simulated: false,
      },
    ],
    ...overrides,
  };
}

describe('Decision Statistics (SQLite)', () => {
  beforeAll(async () => {
    // Clean up any existing test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Ensure data directory exists
    const dataDir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const config = createTestConfig();
    await initializeDatabase(config, logger);
  });

  afterAll(async () => {
    await closeDatabase();
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('getDecisionStats', () => {
    const storage = createStorage();

    beforeEach(async () => {
      // Clean up between tests
      const { db, schema } = getDatabaseContext();
      await (db.delete(schema.decisions) as unknown as { run(): void }).run();
      await (db.delete(schema.alerts) as unknown as { run(): void }).run();
    });

    it('should return empty stats when no decisions exist', async () => {
      const stats = await storage.getDecisionStats();

      expect(stats).toHaveProperty('totalDecisions');
      expect(stats.totalDecisions).toBe(0);
      expect(stats.byDayOfWeek).toEqual([]);
      expect(stats.byHourOfDay).toEqual([]);
      expect(stats.byDurationCategory).toEqual([]);
      expect(stats.topScenarios).toEqual([]);
      expect(stats.byCountry).toEqual([]);
    });

    it('should count total decisions', async () => {
      // Store alerts with decisions
      const alert1 = createTestAlert({
        uuid: 'alert-1',
        source: { scope: 'ip', value: '10.0.0.1', ip: '10.0.0.1', cn: 'US' },
        decisions: [
          {
            uuid: 'decision-1',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.0.0.1',
            duration: '4h',
            scenario: 'crowdsecurity/http-bad-user-agent',
            simulated: false,
          },
        ],
      });
      const alert2 = createTestAlert({
        uuid: 'alert-2',
        source: { scope: 'ip', value: '10.0.0.2', ip: '10.0.0.2', cn: 'FR' },
        decisions: [
          {
            uuid: 'decision-2',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.0.0.2',
            duration: '24h',
            scenario: 'crowdsecurity/ssh-bf',
            simulated: false,
          },
          {
            uuid: 'decision-3',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.0.0.2',
            duration: '168h',
            scenario: 'crowdsecurity/ssh-bf',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts(
        [alert1, alert2],
        [
          { filtered: false, matchedFilters: [] },
          { filtered: false, matchedFilters: [] },
        ],
        undefined
      );

      const stats = await storage.getDecisionStats();

      expect(stats.totalDecisions).toBe(3);
    });

    it('should categorize durations correctly', async () => {
      // Create alerts with various duration types
      const alerts = [
        createTestAlert({
          uuid: 'alert-dur-1',
          source: { scope: 'ip', value: '10.1.0.1', ip: '10.1.0.1', cn: 'US' },
          decisions: [
            {
              uuid: 'dur-1',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.1.0.1',
              duration: '30s', // <1h
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-dur-2',
          source: { scope: 'ip', value: '10.1.0.2', ip: '10.1.0.2', cn: 'US' },
          decisions: [
            {
              uuid: 'dur-2',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.1.0.2',
              duration: '30m', // <1h
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-dur-3',
          source: { scope: 'ip', value: '10.1.0.3', ip: '10.1.0.3', cn: 'US' },
          decisions: [
            {
              uuid: 'dur-3',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.1.0.3',
              duration: '4h', // 1-24h
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-dur-4',
          source: { scope: 'ip', value: '10.1.0.4', ip: '10.1.0.4', cn: 'US' },
          decisions: [
            {
              uuid: 'dur-4',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.1.0.4',
              duration: '72h', // 1-7d
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-dur-5',
          source: { scope: 'ip', value: '10.1.0.5', ip: '10.1.0.5', cn: 'US' },
          decisions: [
            {
              uuid: 'dur-5',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.1.0.5',
              duration: '720h', // >7d
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
      ];

      await storage.storeAlerts(
        alerts,
        alerts.map(() => ({ filtered: false, matchedFilters: [] })),
        undefined
      );

      const stats = await storage.getDecisionStats();

      expect(stats.totalDecisions).toBe(5);

      // Check duration categories
      const categories = new Map(stats.byDurationCategory.map((c) => [c.category, c.count]));

      // 30s and 30m should both be <1h
      expect(categories.get('<1h')).toBe(2);
      // 4h should be 1-24h
      expect(categories.get('1-24h')).toBe(1);
      // 72h should be 1-7d
      expect(categories.get('1-7d')).toBe(1);
      // 720h should be >7d
      expect(categories.get('>7d')).toBe(1);
    });

    it('should group by scenario', async () => {
      const alerts = [
        createTestAlert({
          uuid: 'alert-scen-1',
          source: { scope: 'ip', value: '10.2.0.1', ip: '10.2.0.1', cn: 'US' },
          decisions: [
            {
              uuid: 'scen-1',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.2.0.1',
              duration: '4h',
              scenario: 'crowdsecurity/http-bad-user-agent',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-scen-2',
          source: { scope: 'ip', value: '10.2.0.2', ip: '10.2.0.2', cn: 'US' },
          decisions: [
            {
              uuid: 'scen-2',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.2.0.2',
              duration: '4h',
              scenario: 'crowdsecurity/http-bad-user-agent',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-scen-3',
          source: { scope: 'ip', value: '10.2.0.3', ip: '10.2.0.3', cn: 'US' },
          decisions: [
            {
              uuid: 'scen-3',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.2.0.3',
              duration: '4h',
              scenario: 'crowdsecurity/ssh-bf',
              simulated: false,
            },
          ],
        }),
      ];

      await storage.storeAlerts(
        alerts,
        alerts.map(() => ({ filtered: false, matchedFilters: [] })),
        undefined
      );

      const stats = await storage.getDecisionStats();

      expect(stats.topScenarios.length).toBe(2);

      // Top scenario should be http-bad-user-agent with count 2
      const topScenario = stats.topScenarios.find(
        (s) => s.scenario === 'crowdsecurity/http-bad-user-agent'
      );
      expect(topScenario).toBeDefined();
      expect(topScenario?.count).toBe(2);

      // ssh-bf should have count 1
      const sshScenario = stats.topScenarios.find((s) => s.scenario === 'crowdsecurity/ssh-bf');
      expect(sshScenario).toBeDefined();
      expect(sshScenario?.count).toBe(1);
    });

    it('should group by country', async () => {
      const alerts = [
        createTestAlert({
          uuid: 'alert-country-1',
          source: { scope: 'ip', value: '10.3.0.1', ip: '10.3.0.1', cn: 'US' },
          decisions: [
            {
              uuid: 'country-1',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.3.0.1',
              duration: '4h',
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-country-2',
          source: { scope: 'ip', value: '10.3.0.2', ip: '10.3.0.2', cn: 'US' },
          decisions: [
            {
              uuid: 'country-2',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.3.0.2',
              duration: '4h',
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: 'alert-country-3',
          source: { scope: 'ip', value: '10.3.0.3', ip: '10.3.0.3', cn: 'FR' },
          decisions: [
            {
              uuid: 'country-3',
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.3.0.3',
              duration: '4h',
              scenario: 'test/scenario',
              simulated: false,
            },
          ],
        }),
      ];

      await storage.storeAlerts(
        alerts,
        alerts.map(() => ({ filtered: false, matchedFilters: [] })),
        undefined
      );

      const stats = await storage.getDecisionStats();

      expect(stats.byCountry.length).toBe(2);

      const usCount = stats.byCountry.find((c) => c.countryCode === 'US');
      expect(usCount).toBeDefined();
      expect(usCount?.count).toBe(2);

      const frCount = stats.byCountry.find((c) => c.countryCode === 'FR');
      expect(frCount).toBeDefined();
      expect(frCount?.count).toBe(1);
    });

    it('should filter out null country codes', async () => {
      // Create alert without country info
      const alert = createTestAlert({
        uuid: 'alert-no-country',
        source: { scope: 'ip', value: '10.4.0.1', ip: '10.4.0.1' }, // No cn field
        decisions: [
          {
            uuid: 'no-country-dec',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.4.0.1',
            duration: '4h',
            scenario: 'test/scenario',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const stats = await storage.getDecisionStats();

      // byCountry should be empty since we filter out null country codes
      expect(stats.byCountry.length).toBe(0);
      // But total should still count the decision
      expect(stats.totalDecisions).toBe(1);
    });

    it('should filter out null durations', async () => {
      // Create alert with null duration
      const alert = createTestAlert({
        uuid: 'alert-no-duration',
        source: { scope: 'ip', value: '10.5.0.1', ip: '10.5.0.1', cn: 'US' },
        decisions: [
          {
            uuid: 'no-duration-dec',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.5.0.1',
            // duration is missing/undefined
            scenario: 'test/scenario',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const stats = await storage.getDecisionStats();

      // byDurationCategory should be empty since we filter out null durations
      expect(stats.byDurationCategory.length).toBe(0);
      // But total should still count the decision
      expect(stats.totalDecisions).toBe(1);
    });

    it('should filter by since date', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Store an alert
      const alert = createTestAlert({
        uuid: 'alert-since',
        source: { scope: 'ip', value: '10.6.0.1', ip: '10.6.0.1', cn: 'US' },
        decisions: [
          {
            uuid: 'since-dec',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.6.0.1',
            duration: '4h',
            scenario: 'test/scenario',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      // Query with since=1 hour ago - should include the alert
      const stats = await storage.getDecisionStats(oneHourAgo);
      expect(stats.totalDecisions).toBe(1);

      // Query with since=future - should not include the alert
      const futureDate = new Date(now.getTime() + 60 * 60 * 1000);
      const emptyStats = await storage.getDecisionStats(futureDate);
      expect(emptyStats.totalDecisions).toBe(0);
    });

    it('should return correct day of week structure', async () => {
      const alert = createTestAlert({
        uuid: 'alert-dow',
        source: { scope: 'ip', value: '10.7.0.1', ip: '10.7.0.1', cn: 'US' },
        decisions: [
          {
            uuid: 'dow-dec',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.7.0.1',
            duration: '4h',
            scenario: 'test/scenario',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const stats = await storage.getDecisionStats();

      expect(stats.byDayOfWeek.length).toBeGreaterThan(0);

      for (const day of stats.byDayOfWeek) {
        expect(day).toHaveProperty('day');
        expect(day).toHaveProperty('dayName');
        expect(day).toHaveProperty('count');
        expect(typeof day.day).toBe('number');
        expect(day.day).toBeGreaterThanOrEqual(0);
        expect(day.day).toBeLessThanOrEqual(6);
        expect(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).toContain(day.dayName);
        expect(typeof day.count).toBe('number');
      }
    });

    it('should return correct hour of day structure', async () => {
      const alert = createTestAlert({
        uuid: 'alert-hod',
        source: { scope: 'ip', value: '10.8.0.1', ip: '10.8.0.1', cn: 'US' },
        decisions: [
          {
            uuid: 'hod-dec',
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '10.8.0.1',
            duration: '4h',
            scenario: 'test/scenario',
            simulated: false,
          },
        ],
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const stats = await storage.getDecisionStats();

      expect(stats.byHourOfDay.length).toBeGreaterThan(0);

      for (const hour of stats.byHourOfDay) {
        expect(hour).toHaveProperty('hour');
        expect(hour).toHaveProperty('count');
        expect(typeof hour.hour).toBe('number');
        expect(hour.hour).toBeGreaterThanOrEqual(0);
        expect(hour.hour).toBeLessThanOrEqual(23);
        expect(typeof hour.count).toBe('number');
      }
    });
  });
});
