/**
 * PostgreSQL Integration Tests
 *
 * These tests run against a real PostgreSQL database.
 * They are designed to run in CI with a PostgreSQL service container.
 *
 * Required environment variables:
 *   STORAGE_TYPE=postgres
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase, getDatabaseContext } from '../src/db/index.js';
import { createStorage } from '../src/storage/index.js';
import type { Alert } from '../src/models/alert.js';
import type { Config } from '../src/config/index.js';
import pino from 'pino';

// Skip tests if not configured for PostgreSQL
const isPostgresConfigured =
  process.env.STORAGE_TYPE === 'postgres' &&
  process.env.POSTGRES_DATABASE &&
  process.env.POSTGRES_USER;

const describePostgres = isPostgresConfigured ? describe : describe.skip;

// Create a silent logger for tests
const logger = pino({ level: 'silent' });

// Create test config from environment
function createTestConfig(): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
      auth: { type: 'none' },
    },
    storage: {
      type: 'postgres',
      path: './data/test.db',
      retention_days: 30,
      postgres: {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: process.env.POSTGRES_DATABASE || 'crowdsieve_test',
        user: process.env.POSTGRES_USER || 'crowdsieve',
        password: process.env.POSTGRES_PASSWORD || '',
        ssl: process.env.POSTGRES_SSL === 'true',
        ssl_reject_unauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false',
        pool_size: 5,
      },
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

// Create a test alert
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

describePostgres('PostgreSQL Integration', () => {
  beforeAll(async () => {
    const config = createTestConfig();
    await initializeDatabase(config, logger);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('Database Connection', () => {
    it('should connect to PostgreSQL successfully', () => {
      const { isPostgres } = getDatabaseContext();
      expect(isPostgres).toBe(true);
    });

    it('should have initialized tables', async () => {
      const { db, schema } = getDatabaseContext();
      // Query alerts table to verify it exists
      const result = await db.select().from(schema.alerts).limit(1);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Storage Operations', () => {
    const storage = createStorage();

    it('should store alerts with decisions', async () => {
      const alert = createTestAlert({
        source: { scope: 'ip', value: '10.0.0.1', ip: '10.0.0.1', cn: 'FR' },
      });

      await storage.storeAlerts(
        [alert],
        [{ filtered: false, matchedFilters: [] }],
        undefined
      );

      const results = await storage.queryAlerts({ sourceIp: '10.0.0.1' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].sourceIp).toBe('10.0.0.1');
      expect(results[0].scenario).toBe('crowdsecurity/test-scenario');
    });

    it('should query alerts with filters', async () => {
      // Store alerts with different countries
      const alertFR = createTestAlert({
        uuid: `test-fr-${Date.now()}`,
        source: { scope: 'ip', value: '10.0.0.2', ip: '10.0.0.2', cn: 'FR' },
      });
      const alertDE = createTestAlert({
        uuid: `test-de-${Date.now()}`,
        source: { scope: 'ip', value: '10.0.0.3', ip: '10.0.0.3', cn: 'DE' },
      });

      await storage.storeAlerts(
        [alertFR, alertDE],
        [
          { filtered: false, matchedFilters: [] },
          { filtered: true, matchedFilters: [{ name: 'test', reason: 'test filter' }] },
        ],
        undefined
      );

      // Query filtered alerts
      const filteredResults = await storage.queryAlerts({ filtered: true });
      expect(filteredResults.some((a) => a.geoCountryCode === 'DE')).toBe(true);

      // Query by country
      const frResults = await storage.queryAlerts({ sourceCountry: 'FR' });
      expect(frResults.length).toBeGreaterThanOrEqual(1);
    });

    it('should query alerts by machine ID', async () => {
      const machineId = `machine-${Date.now()}`;
      const alert = createTestAlert({
        machine_id: machineId,
        source: { scope: 'ip', value: '10.0.0.4', ip: '10.0.0.4', cn: 'US' },
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const results = await storage.queryAlerts({ machineId });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].machineId).toBe(machineId);
    });

    it('should get statistics', async () => {
      const stats = await storage.getStats();

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('filtered');
      expect(stats).toHaveProperty('forwarded');
      expect(stats).toHaveProperty('topScenarios');
      expect(stats).toHaveProperty('topCountries');
      expect(stats).toHaveProperty('timeBounds');

      expect(typeof stats.total).toBe('number');
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(stats.topScenarios)).toBe(true);
      expect(Array.isArray(stats.topCountries)).toBe(true);
    });

    it('should get alert by ID', async () => {
      const alert = createTestAlert({
        uuid: `test-getbyid-${Date.now()}`,
        source: { scope: 'ip', value: '10.0.0.5', ip: '10.0.0.5', cn: 'UK' },
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      // Get the most recent alert
      const results = await storage.queryAlerts({ sourceIp: '10.0.0.5', limit: 1 });
      expect(results.length).toBe(1);

      const retrieved = await storage.getAlertById(results[0].id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.uuid).toBe(alert.uuid);
    });

    it('should cleanup old alerts', async () => {
      // Store an old alert (simulate by using cleanup with 0 days retention)
      const alert = createTestAlert({
        uuid: `test-cleanup-${Date.now()}`,
        source: { scope: 'ip', value: '10.0.0.99', ip: '10.0.0.99', cn: 'XX' },
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      // Cleanup with 0 days should delete everything
      const deleted = await storage.cleanup(0);
      expect(typeof deleted).toBe('number');
      expect(deleted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Date Range Queries', () => {
    const storage = createStorage();

    it('should query alerts since a date', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const alert = createTestAlert({
        uuid: `test-since-${Date.now()}`,
        source: { scope: 'ip', value: '10.1.0.1', ip: '10.1.0.1', cn: 'CA' },
      });

      await storage.storeAlerts([alert], [{ filtered: false, matchedFilters: [] }], undefined);

      const results = await storage.queryAlerts({ since: oneHourAgo });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should get stats with time filter', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const stats = await storage.getStats(oneHourAgo);

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('timeBounds');
    });
  });

  describe('Time Distribution Statistics', () => {
    const storage = createStorage();

    it('should get time distribution stats', async () => {
      // First store some test alerts
      const alerts = [
        createTestAlert({
          uuid: `test-dist-1-${Date.now()}`,
          source: { scope: 'ip', value: '10.2.0.1', ip: '10.2.0.1', cn: 'US' },
          scenario: 'test/scenario-a',
        }),
        createTestAlert({
          uuid: `test-dist-2-${Date.now()}`,
          source: { scope: 'ip', value: '10.2.0.2', ip: '10.2.0.2', cn: 'FR' },
          scenario: 'test/scenario-b',
        }),
      ];

      await storage.storeAlerts(
        alerts,
        alerts.map(() => ({ filtered: false, matchedFilters: [] })),
        undefined
      );

      const stats = await storage.getTimeDistributionStats();

      // Verify structure
      expect(stats).toHaveProperty('byDayOfWeek');
      expect(stats).toHaveProperty('byHourOfDay');
      expect(stats).toHaveProperty('byCountry');
      expect(stats).toHaveProperty('byScenario');
      expect(stats).toHaveProperty('dailyTrend');
      expect(stats).toHaveProperty('totalAlerts');
      expect(stats).toHaveProperty('dateRange');

      // Verify arrays
      expect(Array.isArray(stats.byDayOfWeek)).toBe(true);
      expect(Array.isArray(stats.byHourOfDay)).toBe(true);
      expect(Array.isArray(stats.byCountry)).toBe(true);
      expect(Array.isArray(stats.byScenario)).toBe(true);
      expect(Array.isArray(stats.dailyTrend)).toBe(true);

      // Verify totalAlerts is a number
      expect(typeof stats.totalAlerts).toBe('number');
      expect(stats.totalAlerts).toBeGreaterThanOrEqual(2);

      // Verify dateRange
      expect(stats.dateRange).toHaveProperty('from');
      expect(stats.dateRange).toHaveProperty('to');
    });

    it('should return correct day of week structure', async () => {
      const stats = await storage.getTimeDistributionStats();

      // Each day entry should have day, dayName, and count
      for (const day of stats.byDayOfWeek) {
        expect(day).toHaveProperty('day');
        expect(day).toHaveProperty('dayName');
        expect(day).toHaveProperty('count');
        expect(typeof day.day).toBe('number');
        expect(day.day).toBeGreaterThanOrEqual(0);
        expect(day.day).toBeLessThanOrEqual(6);
        expect(typeof day.dayName).toBe('string');
        expect(typeof day.count).toBe('number');
      }
    });

    it('should return correct hour of day structure', async () => {
      const stats = await storage.getTimeDistributionStats();

      // Each hour entry should have hour and count
      for (const hour of stats.byHourOfDay) {
        expect(hour).toHaveProperty('hour');
        expect(hour).toHaveProperty('count');
        expect(typeof hour.hour).toBe('number');
        expect(hour.hour).toBeGreaterThanOrEqual(0);
        expect(hour.hour).toBeLessThanOrEqual(23);
        expect(typeof hour.count).toBe('number');
      }
    });

    it('should return correct country structure', async () => {
      const stats = await storage.getTimeDistributionStats();

      // Each country entry should have countryCode, countryName, and count
      for (const country of stats.byCountry) {
        expect(country).toHaveProperty('countryCode');
        expect(country).toHaveProperty('countryName');
        expect(country).toHaveProperty('count');
        expect(typeof country.countryCode).toBe('string');
        expect(typeof country.countryName).toBe('string');
        expect(typeof country.count).toBe('number');
      }
    });

    it('should filter by since date', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const stats = await storage.getTimeDistributionStats(oneHourAgo);

      expect(stats).toHaveProperty('totalAlerts');
      expect(typeof stats.totalAlerts).toBe('number');
    });
  });

  describe('Decision Statistics', () => {
    const storage = createStorage();

    it('should get decision stats', async () => {
      // First store some test alerts with decisions
      const alerts = [
        createTestAlert({
          uuid: `test-dec-stats-1-${Date.now()}`,
          source: { scope: 'ip', value: '10.10.0.1', ip: '10.10.0.1', cn: 'US' },
          scenario: 'crowdsecurity/http-bad-user-agent',
          decisions: [
            {
              uuid: `dec-stats-1-${Date.now()}`,
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.10.0.1',
              duration: '4h',
              scenario: 'crowdsecurity/http-bad-user-agent',
              simulated: false,
            },
          ],
        }),
        createTestAlert({
          uuid: `test-dec-stats-2-${Date.now()}`,
          source: { scope: 'ip', value: '10.10.0.2', ip: '10.10.0.2', cn: 'FR' },
          scenario: 'crowdsecurity/ssh-bf',
          decisions: [
            {
              uuid: `dec-stats-2-${Date.now()}`,
              origin: 'crowdsec',
              type: 'ban',
              scope: 'ip',
              value: '10.10.0.2',
              duration: '24h',
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

      // Verify structure
      expect(stats).toHaveProperty('totalDecisions');
      expect(stats).toHaveProperty('byDayOfWeek');
      expect(stats).toHaveProperty('byHourOfDay');
      expect(stats).toHaveProperty('byDurationCategory');
      expect(stats).toHaveProperty('topScenarios');
      expect(stats).toHaveProperty('byCountry');

      // Verify types
      expect(typeof stats.totalDecisions).toBe('number');
      expect(stats.totalDecisions).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(stats.byDayOfWeek)).toBe(true);
      expect(Array.isArray(stats.byHourOfDay)).toBe(true);
      expect(Array.isArray(stats.byDurationCategory)).toBe(true);
      expect(Array.isArray(stats.topScenarios)).toBe(true);
      expect(Array.isArray(stats.byCountry)).toBe(true);
    });

    it('should return correct day of week structure for decisions', async () => {
      const stats = await storage.getDecisionStats();

      for (const day of stats.byDayOfWeek) {
        expect(day).toHaveProperty('day');
        expect(day).toHaveProperty('dayName');
        expect(day).toHaveProperty('count');
        expect(typeof day.day).toBe('number');
        expect(day.day).toBeGreaterThanOrEqual(0);
        expect(day.day).toBeLessThanOrEqual(6);
        expect(typeof day.dayName).toBe('string');
        expect(typeof day.count).toBe('number');
      }
    });

    it('should return correct hour of day structure for decisions', async () => {
      const stats = await storage.getDecisionStats();

      for (const hour of stats.byHourOfDay) {
        expect(hour).toHaveProperty('hour');
        expect(hour).toHaveProperty('count');
        expect(typeof hour.hour).toBe('number');
        expect(hour.hour).toBeGreaterThanOrEqual(0);
        expect(hour.hour).toBeLessThanOrEqual(23);
        expect(typeof hour.count).toBe('number');
      }
    });

    it('should return correct duration category structure', async () => {
      const stats = await storage.getDecisionStats();

      for (const category of stats.byDurationCategory) {
        expect(category).toHaveProperty('category');
        expect(category).toHaveProperty('count');
        expect(typeof category.category).toBe('string');
        expect(['<1h', '1-24h', '1-7d', '>7d']).toContain(category.category);
        expect(typeof category.count).toBe('number');
      }
    });

    it('should return correct scenario structure for decisions', async () => {
      const stats = await storage.getDecisionStats();

      for (const scenario of stats.topScenarios) {
        expect(scenario).toHaveProperty('scenario');
        expect(scenario).toHaveProperty('count');
        expect(typeof scenario.scenario).toBe('string');
        expect(typeof scenario.count).toBe('number');
      }
    });

    it('should return correct country structure for decisions', async () => {
      const stats = await storage.getDecisionStats();

      for (const country of stats.byCountry) {
        expect(country).toHaveProperty('countryCode');
        expect(country).toHaveProperty('countryName');
        expect(country).toHaveProperty('count');
        expect(typeof country.countryCode).toBe('string');
        expect(typeof country.countryName).toBe('string');
        expect(typeof country.count).toBe('number');
      }
    });

    it('should filter decision stats by since date', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const stats = await storage.getDecisionStats(oneHourAgo);

      expect(stats).toHaveProperty('totalDecisions');
      expect(typeof stats.totalDecisions).toBe('number');
    });
  });
});
