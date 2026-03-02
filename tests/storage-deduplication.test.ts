import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { createStorage, type AlertStorage } from '../src/storage/index.js';
import type { Alert } from '../src/models/alert.js';
import type { FilterEngineResult } from '../src/filters/types.js';

// Create in-memory database for testing
let sqlite: Database.Database;

function setupTestDatabase() {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Create tables (inline migration)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT,
      machine_id TEXT,
      scenario TEXT NOT NULL,
      scenario_hash TEXT,
      scenario_version TEXT,
      message TEXT,
      events_count INTEGER,
      capacity INTEGER,
      leakspeed TEXT,
      start_at TEXT,
      stop_at TEXT,
      created_at TEXT,
      received_at TEXT NOT NULL,
      simulated INTEGER DEFAULT 0,
      remediation INTEGER DEFAULT 0,
      has_decisions INTEGER DEFAULT 0,
      replicated INTEGER DEFAULT 0,
      source_scope TEXT,
      source_value TEXT,
      source_ip TEXT,
      source_range TEXT,
      source_as_number TEXT,
      source_as_name TEXT,
      source_cn TEXT,
      geo_country_code TEXT,
      geo_country_name TEXT,
      geo_city TEXT,
      geo_region TEXT,
      geo_latitude REAL,
      geo_longitude REAL,
      geo_timezone TEXT,
      geo_isp TEXT,
      geo_org TEXT,
      filtered INTEGER DEFAULT 0,
      filter_reasons TEXT,
      forwarded_to_capi INTEGER DEFAULT 0,
      forwarded_at TEXT,
      raw_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_uuid ON alerts(uuid) WHERE uuid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
      uuid TEXT,
      origin TEXT,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      value TEXT NOT NULL,
      duration TEXT,
      scenario TEXT,
      simulated INTEGER DEFAULT 0,
      until TEXT,
      created_at TEXT
    );
  `);
}

function createMockAlert(
  uuid?: string,
  decisionOrigin = 'crowdsec',
  withDecisions = true
): Alert {
  return {
    uuid,
    scenario: 'crowdsecurity/ssh-bf',
    scenario_hash: 'abc123',
    scenario_version: '1.0.0',
    message: 'SSH bruteforce attack',
    events_count: 10,
    start_at: '2024-01-01T00:00:00Z',
    stop_at: '2024-01-01T00:01:00Z',
    capacity: 10,
    leakspeed: '10s',
    simulated: false,
    events: [],
    source: {
      scope: 'ip',
      value: '192.168.1.100',
    },
    decisions: withDecisions
      ? [
          {
            origin: decisionOrigin,
            type: 'ban',
            scope: 'ip',
            value: '192.168.1.100',
            duration: '4h',
            scenario: 'crowdsecurity/ssh-bf',
          },
        ]
      : undefined,
  };
}

function createMockFilterDetails(
  count: number
): FilterEngineResult['filterDetails'] {
  return Array.from({ length: count }, (_, i) => ({
    alertIndex: i,
    filtered: false,
    matchedFilters: [],
  }));
}

// Mock getDatabaseContext to use our test database
vi.mock('../src/db/index.js', () => ({
  getDatabaseContext: () => {
    const db = drizzle(sqlite, { schema });
    return { db, schema, isPostgres: false };
  },
}));

describe('Storage Deduplication', () => {
  let storage: AlertStorage;

  beforeEach(() => {
    setupTestDatabase();
    storage = createStorage();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('isReplicatedAlert - Skip alerts with crowdsieve-replication origin', () => {
    it('should store alerts without decisions', async () => {
      const alerts = [createMockAlert('uuid-1', 'crowdsec', false)];
      const filterDetails = createMockFilterDetails(1);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should store alerts with non-replication origin decisions', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'crowdsec'),
        createMockAlert('uuid-2', 'capi'),
        createMockAlert('uuid-3', 'local'),
      ];
      const filterDetails = createMockFilterDetails(3);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(3);
    });

    it('should SKIP alerts with crowdsieve-replication origin decisions', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'crowdsieve-replication'),
        createMockAlert('uuid-2', 'crowdsec'), // This one should be stored
      ];
      const filterDetails = createMockFilterDetails(2);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(1);

      const stored = sqlite.prepare('SELECT uuid FROM alerts').get() as { uuid: string };
      expect(stored.uuid).toBe('uuid-2');
    });

    it('should handle case-insensitive replication origin', async () => {
      const alertsUpperCase = [createMockAlert('uuid-upper', 'CROWDSIEVE-REPLICATION')];
      const alertsMixedCase = [createMockAlert('uuid-mixed', 'CrowdSieve-Replication')];

      await storage.storeAlerts(alertsUpperCase, createMockFilterDetails(1));
      await storage.storeAlerts(alertsMixedCase, createMockFilterDetails(1));

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(0); // Both should be skipped
    });

    it('should SKIP if ANY decision has crowdsieve-replication origin', async () => {
      // Alert with mixed origins - one crowdsieve-replication, one capi
      const mixedAlert: Alert = {
        ...createMockAlert('uuid-mixed'),
        decisions: [
          {
            origin: 'capi',
            type: 'ban',
            scope: 'ip',
            value: '192.168.1.100',
            duration: '4h',
          },
          {
            origin: 'crowdsieve-replication',
            type: 'ban',
            scope: 'ip',
            value: '192.168.1.101',
            duration: '4h',
          },
        ],
      };

      await storage.storeAlerts([mixedAlert], createMockFilterDetails(1));

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(0); // Should be skipped
    });
  });

  describe('UUID deduplication', () => {
    it('should store alert with null UUID', async () => {
      const alerts = [createMockAlert(undefined, 'crowdsec')];
      const filterDetails = createMockFilterDetails(1);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should skip alert with duplicate UUID (same batch)', async () => {
      const alerts = [
        createMockAlert('same-uuid', 'crowdsec'),
        createMockAlert('same-uuid', 'crowdsec'), // Duplicate
      ];
      const filterDetails = createMockFilterDetails(2);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should skip alert with duplicate UUID (different batch)', async () => {
      const alerts1 = [createMockAlert('unique-uuid', 'crowdsec')];
      const alerts2 = [createMockAlert('unique-uuid', 'crowdsec')]; // Same UUID

      await storage.storeAlerts(alerts1, createMockFilterDetails(1));
      await storage.storeAlerts(alerts2, createMockFilterDetails(1));

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('should store alerts with different UUIDs', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'crowdsec'),
        createMockAlert('uuid-2', 'crowdsec'),
        createMockAlert('uuid-3', 'crowdsec'),
      ];
      const filterDetails = createMockFilterDetails(3);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(3);
    });

    it('should allow multiple alerts with null UUID', async () => {
      const alerts = [
        createMockAlert(undefined, 'crowdsec'),
        createMockAlert(undefined, 'crowdsec'),
        createMockAlert(undefined, 'crowdsec'),
      ];
      const filterDetails = createMockFilterDetails(3);

      await storage.storeAlerts(alerts, filterDetails);

      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(3);
    });
  });

  describe('replicableIndices tracking', () => {
    it('should return empty replicableIndices for alerts without replicable decisions', async () => {
      const alerts = [createMockAlert('uuid-1', 'crowdseve', false)];
      const filterDetails = createMockFilterDetails(1);

      const result = await storage.storeAlerts(alerts, filterDetails);

      expect(result.replicableIndices).toEqual([]);
    });

    it('should return replicableIndices for alerts with non-crowdsieve decisions', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'), // Index 0 - replicable
        createMockAlert('uuid-2', 'local'), // Index 1 - replicable
      ];
      const filterDetails = createMockFilterDetails(2);

      const result = await storage.storeAlerts(alerts, filterDetails);

      expect(result.replicableIndices).toEqual([0, 1]);
    });

    it('should exclude crowdsieve origin from replicableIndices', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'), // Index 0 - replicable
        createMockAlert('uuid-2', 'crowdsieve'), // Index 1 - NOT replicable (crowdsieve origin)
        createMockAlert('uuid-3', 'local'), // Index 2 - replicable
      ];
      const filterDetails = createMockFilterDetails(3);

      const result = await storage.storeAlerts(alerts, filterDetails);

      expect(result.replicableIndices).toEqual([0, 2]);
    });
  });

  describe('markAlertsReplicated', () => {
    it('should mark alerts as replicated', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'),
        createMockAlert('uuid-2', 'capi'),
      ];
      const filterDetails = createMockFilterDetails(2);

      const result = await storage.storeAlerts(alerts, filterDetails);

      // Initially not replicated
      let rows = sqlite.prepare('SELECT replicated FROM alerts').all() as { replicated: number }[];
      expect(rows.every((r) => r.replicated === 0)).toBe(true);

      // Mark as replicated
      await storage.markAlertsReplicated(result.replicableIndices);

      // Now replicated
      rows = sqlite.prepare('SELECT replicated FROM alerts').all() as { replicated: number }[];
      expect(rows.every((r) => r.replicated === 1)).toBe(true);
    });

    it('should only mark specific indices as replicated', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'),
        createMockAlert('uuid-2', 'capi'),
        createMockAlert('uuid-3', 'capi'),
      ];
      const filterDetails = createMockFilterDetails(3);

      await storage.storeAlerts(alerts, filterDetails);

      // Only mark index 1 as replicated
      await storage.markAlertsReplicated([1]);

      const rows = sqlite.prepare('SELECT uuid, replicated FROM alerts ORDER BY uuid').all() as { uuid: string; replicated: number }[];
      expect(rows[0].replicated).toBe(0); // uuid-1
      expect(rows[1].replicated).toBe(1); // uuid-2
      expect(rows[2].replicated).toBe(0); // uuid-3
    });
  });

  describe('Index mapping after skipping', () => {
    it('should correctly map indices when alerts are skipped', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'), // Index 0 - stored
        createMockAlert('uuid-1', 'capi'), // Index 1 - skipped (duplicate)
        createMockAlert('uuid-2', 'capi'), // Index 2 - stored
      ];
      const filterDetails = createMockFilterDetails(3);

      const result = await storage.storeAlerts(alerts, filterDetails);

      // Should have stored 2 alerts
      const count = sqlite.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number };
      expect(count.count).toBe(2);

      // replicableIndices should have indices 0 and 2 (index 1 was skipped)
      expect(result.replicableIndices).toEqual([0, 2]);

      // Mark as replicated
      await storage.markAlertsReplicated(result.replicableIndices);

      // Both stored alerts should be replicated
      const replicated = sqlite.prepare('SELECT COUNT(*) as count FROM alerts WHERE replicated = 1').get() as { count: number };
      expect(replicated.count).toBe(2);
    });

    it('should handle markAlertsForwarded with correct index mapping', async () => {
      const alerts = [
        createMockAlert('uuid-1', 'capi'), // Index 0 - stored
        createMockAlert('uuid-1', 'capi'), // Index 1 - skipped (duplicate)
        createMockAlert('uuid-2', 'capi'), // Index 2 - stored
      ];
      const filterDetails = createMockFilterDetails(3);

      await storage.storeAlerts(alerts, filterDetails);

      // Mark index 2 as forwarded (should update uuid-2)
      await storage.markAlertsForwarded([2]);

      const forwarded = sqlite.prepare('SELECT uuid FROM alerts WHERE forwarded_to_capi = 1').all() as { uuid: string }[];
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].uuid).toBe('uuid-2');
    });
  });
});
