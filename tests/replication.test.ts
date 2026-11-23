import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createReplicationService,
  getTrustedSourceMachineIds,
  ReplicationService,
  ReplicationLogger,
  ReplicationSender,
  REPLICATION_ORIGIN,
} from '../src/replication/index.js';
import { parseGoDuration, prepareDecisionForReplication } from '../src/replication/decisions.js';
import type { Config } from '../src/config/index.js';
import type { Alert } from '../src/models/alert.js';
import { clearTokenCache } from '../src/auth/machineToken.js';

// Mock fetch - stubbed in beforeEach
const mockFetch = vi.fn();

// JWT machine id of a LAPI that is only a replication source. createMockConfig
// always lists it, so that TRUSTED_SENDER is allowed to replicate.
const TRUSTED_SOURCE_ID = 'trusted-source-lapi';
const TRUSTED_SENDER: ReplicationSender = { authenticated: true, machineId: TRUSTED_SOURCE_ID };

/** An authenticated sender whose JWT carries `machineId`. */
function sender(machineId: string): ReplicationSender {
  return { authenticated: true, machineId };
}

function mockLapiOk(): void {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/v1/watchers/login')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'mock-token',
            expire: new Date(Date.now() + 3600000).toISOString(),
          }),
      });
    }
    if (url.includes('/v1/alerts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    return Promise.reject(new Error('Unknown URL'));
  });
}

const REPLICATION_TARGET: Config['lapi_servers'][number] = {
  name: 'target',
  url: 'https://target.example.com',
  api_key: 'key',
  machine_id: 'crowdsieve',
  password: 'password',
  replicate_decisions: true,
};

function createMockLogger(): ReplicationLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockConfig(lapiServers: Config['lapi_servers'] = []): Config {
  return {
    proxy: {
      listen_port: 8080,
      capi_url: 'https://api.crowdsec.net',
      timeout_ms: 5000,
      forward_enabled: true,
    },
    lapi_servers: [
      ...lapiServers,
      {
        name: 'source-only',
        url: 'https://source.example.com',
        api_key: 'source-key',
        replicate_decisions: false,
        source_machine_ids: [TRUSTED_SOURCE_ID],
      },
    ],
    storage: {
      type: 'sqlite',
      path: './data/test.db',
      retention_days: 30,
    },
    logging: {
      level: 'info',
      format: 'json',
    },
    filters: {
      mode: 'block',
      rules: [],
    },
    client_validation: {
      enabled: false,
      cache_ttl_seconds: 604800,
      cache_ttl_error_seconds: 3600,
      validation_timeout_ms: 5000,
      max_memory_entries: 1000,
      fail_closed: false,
    },
    analyzers: {
      enabled: false,
      config_dir: './config/analyzers.d',
      default_interval: '3h',
      default_lookback: '3h',
      default_targets: 'all',
      whitelist: [],
      sources: {},
    },
    bouncer_metrics: {
      retention_days: 30,
    },
  };
}

function createMockAlert(withDecision: boolean, machineId?: string, decisionOrigin = 'crowdsec'): Alert {
  const alert: Alert = {
    machine_id: machineId,
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
  };

  if (withDecision) {
    alert.decisions = [
      {
        origin: decisionOrigin,
        type: 'ban',
        scope: 'ip',
        value: '192.168.1.100',
        duration: '4h',
        scenario: 'crowdsecurity/ssh-bf',
      },
    ];
  }

  return alert;
}

describe('ReplicationService', () => {
  let logger: ReplicationLogger;
  let service: ReplicationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    clearTokenCache();
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('replicateDecisions', () => {
    it('should skip replication when no servers have replicate_decisions enabled', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: false,
        },
      ]);

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith({}, 'No replication targets configured');
    });

    it('should skip replication when alerts have no decisions', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(false)];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith({}, 'No alerts with decisions to replicate');
    });

    it('should skip servers without machine credentials', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          // No machine_id or password
          replicate_decisions: true,
        },
      ]);

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { server: 'server1' },
        'Skipping replication target: no machine credentials'
      );
    });

    it('should skip source server using source_machine_ids (loop prevention)', async () => {
      // This tests the fix for the loop bug: when a server has replicate_decisions: true
      // and sends alerts, it should not receive its own decisions back.
      // The source_machine_ids array identifies alerts FROM this server's connected machines,
      // while machine_id is used to POST to this server (different credentials).
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'crowdsieve-push-creds', // credentials for POSTING to this server
          password: 'password1',
          replicate_decisions: true,
          source_machine_ids: ['lapi-sender-id', 'another-machine'], // machine_ids that send alerts from this LAPI
        },
      ]);

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true, 'lapi-sender-id')];

      // Alert comes from lapi-sender-id, which is in source_machine_ids
      await service.replicateDecisions(alerts, sender('lapi-sender-id'));

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { server: 'server1', sourceMachineId: 'lapi-sender-id', source_machine_ids: ['lapi-sender-id', 'another-machine'] },
        'Skipping replication target: source machine is in source_machine_ids'
      );
    });

    it('should skip source server when any machine from source_machine_ids matches', async () => {
      // Test with multiple machines connected to the same LAPI
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'crowdsieve',
          password: 'password1',
          replicate_decisions: true,
          source_machine_ids: ['bbb2', 'machine-x', 'machine-y'], // All machines on this LAPI
        },
      ]);

      service = createReplicationService(config, logger);

      // Test with different source machines - all should be skipped
      for (const sourceMachine of ['bbb2', 'machine-x', 'machine-y']) {
        vi.clearAllMocks();
        const alerts = [createMockAlert(true, sourceMachine)];
        await service.replicateDecisions(alerts, sender(sourceMachine));
        expect(mockFetch).not.toHaveBeenCalled();
      }
    });

    it('should replicate to server when source machine is NOT in source_machine_ids', async () => {
      // Test cross-replication between two LAPIs
      const config = createMockConfig([
        {
          name: 'lapi1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'crowdsieve-lapi1',
          password: 'password1',
          replicate_decisions: true,
          source_machine_ids: ['machine-a', 'machine-b'], // Machines on lapi1
        },
        {
          name: 'lapi2',
          url: 'https://lapi2.example.com',
          api_key: 'key2',
          machine_id: 'crowdsieve-lapi2',
          password: 'password2',
          replicate_decisions: true,
          source_machine_ids: ['machine-c'], // Machines on lapi2
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Alert from machine-a (on lapi1) should only replicate to lapi2
      const alerts = [createMockAlert(true, 'machine-a')];
      await service.replicateDecisions(alerts, sender('machine-a'));

      // Should only call lapi2 (login + alerts = 2 calls)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
      expect(calledUrls).toContain('https://lapi2.example.com/v1/watchers/login');
      expect(calledUrls).toContain('https://lapi2.example.com/v1/alerts');
      expect(calledUrls).not.toContain('https://lapi1.example.com/v1/alerts');
    });

    it('should replicate to servers with replicate_decisions enabled', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      // Mock login response
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Should have called login and then alerts
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check login call
      expect(mockFetch).toHaveBeenCalledWith(
        'https://lapi1.example.com/v1/watchers/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            machine_id: 'machine1',
            password: 'password1',
          }),
        })
      );

      // Check alerts call
      expect(mockFetch).toHaveBeenCalledWith(
        'https://lapi1.example.com/v1/alerts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        { server: 'server1', alertCount: 1 },
        'Successfully replicated decisions to LAPI'
      );
    });

    it('should replicate to multiple servers in parallel', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
        {
          name: 'server2',
          url: 'https://lapi2.example.com',
          api_key: 'key2',
          machine_id: 'machine2',
          password: 'password2',
          replicate_decisions: true,
        },
        {
          name: 'server3',
          url: 'https://lapi3.example.com',
          api_key: 'key3',
          machine_id: 'machine3',
          password: 'password3',
          replicate_decisions: false, // This one should be skipped
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Should have called login and alerts for 2 servers (4 total calls)
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Verify calls to both enabled servers
      const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
      expect(calledUrls).toContain('https://lapi1.example.com/v1/watchers/login');
      expect(calledUrls).toContain('https://lapi2.example.com/v1/watchers/login');
      expect(calledUrls).toContain('https://lapi1.example.com/v1/alerts');
      expect(calledUrls).toContain('https://lapi2.example.com/v1/alerts');

      // Should NOT have called server3
      expect(calledUrls).not.toContain('https://lapi3.example.com/v1/watchers/login');
    });

    it('should handle authentication failure gracefully', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'wrong-password',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Invalid credentials'),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      // Should not throw
      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(logger.warn).toHaveBeenCalledWith(
        { server: 'server1' },
        'Failed to get machine token for replication'
      );
    });

    it('should handle LAPI error gracefully', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal server error'),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      // Should not throw
      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'server1',
          status: 500,
        }),
        'Failed to replicate decisions to LAPI'
      );
    });

    it('should handle network errors gracefully', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockRejectedValue(new Error('Network error'));

      service = createReplicationService(config, logger);
      const alerts = [createMockAlert(true)];

      // Should not throw
      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'server1',
          err: expect.any(Error),
        }),
        'Error getting machine token'
      );
    });

    it('should only replicate alerts with decisions (filtered alerts too)', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Mix of alerts with and without decisions
      const alerts = [
        createMockAlert(true), // Has decision - should be replicated
        createMockAlert(false), // No decision - should NOT be replicated
        createMockAlert(true), // Has decision - should be replicated
      ];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Check that only 2 alerts were sent (those with decisions)
      const alertsCall = mockFetch.mock.calls.find((call) => (call[0] as string).includes('/v1/alerts'));
      expect(alertsCall).toBeDefined();

      const body = JSON.parse(alertsCall![1].body as string);
      expect(body).toHaveLength(2);
      expect(body[0].decisions).toBeDefined();
      expect(body[1].decisions).toBeDefined();
    });

    it('should NOT replicate decisions with crowdsieve origin (prevent loops)', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Alert with crowdsieve origin - should NOT be replicated
      const alerts = [createMockAlert(true, undefined, 'crowdsieve')];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Should skip without fetching token because no replicable decisions after filtering
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(logger.debug).toHaveBeenCalledWith(
        {},
        'No replicable decisions after filtering'
      );
    });

    it('should NOT replicate decisions with crowdsieve-replication origin (prevent loops)', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Alert with crowdsieve-replication origin - should NOT be replicated
      const alerts = [createMockAlert(true, undefined, 'crowdsieve-replication')];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Should skip without fetching token because no replicable decisions after filtering
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(logger.debug).toHaveBeenCalledWith(
        {},
        'No replicable decisions after filtering'
      );
    });

    it('should change origin to crowdsieve-replication when replicating', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Alert with capi origin - should be replicated with changed origin
      const alerts = [createMockAlert(true, undefined, 'capi')];

      await service.replicateDecisions(alerts, TRUSTED_SENDER);

      // Check that the origin was changed to crowdsieve-replication
      const alertsCall = mockFetch.mock.calls.find((call) => (call[0] as string).includes('/v1/alerts'));
      expect(alertsCall).toBeDefined();

      const body = JSON.parse(alertsCall![1].body as string);
      expect(body).toHaveLength(1);
      expect(body[0].decisions[0].origin).toBe(REPLICATION_ORIGIN);
    });

    it('should provide default values for missing required LAPI fields', async () => {
      const config = createMockConfig([
        {
          name: 'server1',
          url: 'https://lapi1.example.com',
          api_key: 'key1',
          machine_id: 'machine1',
          password: 'password1',
          replicate_decisions: true,
        },
      ]);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/v1/watchers/login')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                token: 'mock-token',
                expire: new Date(Date.now() + 3600000).toISOString(),
              }),
          });
        }
        if (url.includes('/v1/alerts')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      service = createReplicationService(config, logger);

      // Alert with missing required fields (like real CAPI signals)
      const alertWithMissingFields: Alert = {
        scenario: 'crowdsecurity/http-bad-user-agent',
        scenario_hash: 'abc123',
        scenario_version: '1.0',
        message: 'Test alert',
        start_at: '2024-01-01T00:00:00Z',
        stop_at: '2024-01-01T00:01:00Z',
        source: {
          scope: 'ip',
          value: '192.168.1.100',
        },
        decisions: [
          {
            origin: 'crowdsec',
            type: 'ban',
            scope: 'ip',
            value: '192.168.1.100',
            duration: '4h',
            scenario: 'crowdsecurity/http-bad-user-agent',
          },
        ],
        // Missing: events_count, capacity, leakspeed, simulated, events
      };

      await service.replicateDecisions([alertWithMissingFields], TRUSTED_SENDER);

      // Check that the alert was sent with default values for required fields
      const alertsCall = mockFetch.mock.calls.find((call) =>
        (call[0] as string).includes('/v1/alerts')
      );
      expect(alertsCall).toBeDefined();

      const body = JSON.parse(alertsCall![1].body as string);
      expect(body).toHaveLength(1);
      expect(body[0].events_count).toBe(1);
      expect(body[0].capacity).toBe(0);
      expect(body[0].leakspeed).toBe('0s');
      expect(body[0].simulated).toBe(false);
      expect(body[0].events).toEqual([]);
    });
  });

  describe('sender authorization (GHSA-8gp7-jp8p-g9xr)', () => {
    function internetBan(machineId?: string): Alert {
      const alert = createMockAlert(true, machineId);
      alert.decisions = [
        {
          origin: 'crowdsec',
          type: 'ban',
          scope: 'Range',
          value: '0.0.0.0/0',
          duration: '87600h',
          scenario: 'crowdsecurity/ssh-bf',
        },
      ];
      return alert;
    }

    beforeEach(() => {
      mockLapiOk();
    });

    it('does not replicate an unauthenticated signal carrying 0.0.0.0/0', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);

      const outcome = await service.replicateDecisions([internetBan(TRUSTED_SOURCE_ID)], {
        authenticated: false,
        reason: 'no_auth_header',
        // Even a body claiming a trusted machine id must not help.
        reportedMachineIds: [TRUSTED_SOURCE_ID],
      });

      expect(outcome).toBe('refused');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'no_auth_header', alertCount: 1 },
        'Not replicating decisions: sender is not authenticated against CAPI'
      );
    });

    it('does not replicate from a fail-open (unauthenticated) sender', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);

      const outcome = await service.replicateDecisions([createMockAlert(true)], {
        authenticated: false,
        reason: 'capi_error_failopen',
        machineId: TRUSTED_SOURCE_ID,
      });

      expect(outcome).toBe('refused');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not replicate from a validated sender that is not in any source_machine_ids', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);

      const outcome = await service.replicateDecisions(
        [createMockAlert(true, TRUSTED_SOURCE_ID)],
        { authenticated: true, machineId: 'some-other-capi-machine' }
      );

      expect(outcome).toBe('refused');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { machineId: 'some-other-capi-machine', alertCount: 1 },
        'Not replicating decisions: sender machine id is not listed in any lapi_servers[].source_machine_ids'
      );
    });

    it('does not replicate from an authenticated sender without a JWT machine id', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);

      const outcome = await service.replicateDecisions([createMockAlert(true)], {
        authenticated: true,
      });

      expect(outcome).toBe('refused');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('logs a refused sender at warn level once, then at debug level', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);
      const untrusted = { authenticated: true, machineId: 'some-other-capi-machine' };

      await service.replicateDecisions([createMockAlert(true)], untrusted);
      await service.replicateDecisions([createMockAlert(true)], untrusted);
      await service.replicateDecisions([createMockAlert(true)], {
        authenticated: true,
        machineId: 'yet-another-machine',
      });

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.debug).toHaveBeenCalledWith(
        { machineId: 'some-other-capi-machine', alertCount: 1 },
        'Not replicating decisions: sender machine id is not listed in any lapi_servers[].source_machine_ids'
      );
    });

    it('replicates from a validated, trusted sender', async () => {
      service = createReplicationService(createMockConfig([REPLICATION_TARGET]), logger);

      const outcome = await service.replicateDecisions([createMockAlert(true)], TRUSTED_SENDER);

      expect(outcome).toBe('replicated');
      const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
      expect(calledUrls).toContain('https://target.example.com/v1/alerts');
    });

    it('excludes the server listing the JWT machine id, whatever the body claims', async () => {
      const config = createMockConfig([
        { ...REPLICATION_TARGET, name: 'lapi1', url: 'https://lapi1.example.com', source_machine_ids: ['capi-lapi1'] },
        { ...REPLICATION_TARGET, name: 'lapi2', url: 'https://lapi2.example.com', source_machine_ids: ['capi-lapi2'] },
      ]);
      service = createReplicationService(config, logger);

      // Alerts claim to come from an agent of lapi2; the JWT says lapi1.
      await service.replicateDecisions([createMockAlert(true, 'agent-unknown')], {
        ...sender('capi-lapi1'),
        reportedMachineIds: ['agent-unknown'],
      });

      const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
      expect(calledUrls).toContain('https://lapi2.example.com/v1/alerts');
      expect(calledUrls).not.toContain('https://lapi1.example.com/v1/alerts');
    });

    it('lets machine ids reported in the body exclude more targets (agent-id configurations)', async () => {
      const config = createMockConfig([
        {
          ...REPLICATION_TARGET,
          name: 'lapi1',
          url: 'https://lapi1.example.com',
          source_machine_ids: ['capi-lapi1', 'agent-a'],
        },
        {
          ...REPLICATION_TARGET,
          name: 'lapi2',
          url: 'https://lapi2.example.com',
          source_machine_ids: ['capi-lapi2', 'agent-c'],
        },
      ]);
      service = createReplicationService(config, logger);

      await service.replicateDecisions([createMockAlert(true, 'agent-c')], {
        ...sender('capi-lapi1'),
        reportedMachineIds: ['agent-c'],
      });

      // lapi1 excluded by the JWT id, lapi2 by the reported agent id.
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getTrustedSourceMachineIds', () => {
    it('is the union of all source_machine_ids, replication targets or not', () => {
      const ids = getTrustedSourceMachineIds({
        lapi_servers: [
          { ...REPLICATION_TARGET, source_machine_ids: ['a', 'b'] },
          { ...REPLICATION_TARGET, replicate_decisions: false, source_machine_ids: ['b', 'c'] },
          { ...REPLICATION_TARGET },
        ],
      });
      expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    });

    it('is empty when no server lists source_machine_ids', () => {
      expect(getTrustedSourceMachineIds({ lapi_servers: [REPLICATION_TARGET] }).size).toBe(0);
    });
  });

  describe('replicated decision limits (GHSA-8gp7-jp8p-g9xr)', () => {
    function alertWith(decisions: Array<Record<string, unknown>>): Alert {
      const alert = createMockAlert(false);
      alert.decisions = decisions.map((d) => ({
        origin: 'crowdsec',
        type: 'ban',
        scope: 'Ip',
        value: '192.0.2.1',
        duration: '4h',
        scenario: 'crowdsecurity/ssh-bf',
        ...d,
      })) as Alert['decisions'];
      return alert;
    }

    async function replicatedDecisions(
      alerts: Alert[],
      config: Config = createMockConfig([REPLICATION_TARGET])
    ): Promise<Array<Record<string, unknown>> | undefined> {
      service = createReplicationService(config, logger);
      await service.replicateDecisions(alerts, TRUSTED_SENDER);
      const call = mockFetch.mock.calls.find((c) => String(c[0]).endsWith('/v1/alerts'));
      if (!call) return undefined;
      const body = JSON.parse(call[1].body as string) as Array<{
        decisions: Array<Record<string, unknown>>;
      }>;
      return body.flatMap((a) => a.decisions);
    }

    beforeEach(() => {
      mockLapiOk();
    });

    it('does not replicate 0.0.0.0/0 or ::/0, even from a trusted sender', async () => {
      const decisions = await replicatedDecisions([
        alertWith([
          { scope: 'Range', value: '0.0.0.0/0' },
          { scope: 'Range', value: '::/0' },
        ]),
      ]);

      expect(decisions).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ droppedCount: 2 }),
        'Dropped decisions that may not be replicated (scope, type, range width or duration)'
      );
    });

    it('drops over-broad ranges and keeps the others', async () => {
      const decisions = await replicatedDecisions([
        alertWith([
          { scope: 'Range', value: '10.0.0.0/8' },
          { scope: 'Range', value: '10.0.0.0/15' },
          { scope: 'Range', value: '10.1.0.0/16' },
          { scope: 'range', value: '198.51.100.0/24' },
          { scope: 'Range', value: '2000::/3' },
          { scope: 'Range', value: '2001:db8::/31' },
          { scope: 'Range', value: '2001:db8::/32' },
          { scope: 'Range', value: '::ffff:0:0/96' },
          { scope: 'Range', value: '::/32' },
          { scope: 'Range', value: '::ffff:10.0.0.0/104' },
          { scope: 'Range', value: '::ffff:10.1.0.0/112' },
        ]),
      ]);

      expect(decisions?.map((d) => d.value)).toEqual([
        '10.1.0.0/16',
        '198.51.100.0/24',
        '2001:db8::/32',
        '::ffff:10.1.0.0/112',
      ]);
      expect(decisions?.every((d) => d.scope === 'Range')).toBe(true);
    });

    it('only replicates Ip and Range scopes and ban/captcha types', async () => {
      const decisions = await replicatedDecisions([
        alertWith([
          { scope: 'Country', value: 'FR' },
          { scope: 'AS', value: '64496' },
          { scope: 'Username', value: 'root' },
          { type: 'throttle', value: '192.0.2.2' },
          { type: 'custom-remediation', value: '192.0.2.3' },
          { type: 'captcha', value: '192.0.2.4' },
          { type: 'BAN', scope: 'ip', value: '192.0.2.5' },
          { scope: 'Ip', value: '192.0.2.0/24' },
          { scope: 'Ip', value: 'not-an-ip' },
        ]),
      ]);

      expect(decisions).toEqual([
        expect.objectContaining({ type: 'captcha', scope: 'Ip', value: '192.0.2.4' }),
        expect.objectContaining({ type: 'ban', scope: 'Ip', value: '192.0.2.5' }),
      ]);
    });

    it('caps excessive durations to the default 168h and drops invalid ones', async () => {
      const decisions = await replicatedDecisions([
        alertWith([
          { value: '192.0.2.1', duration: '87600h' },
          { value: '192.0.2.2', duration: '168h0m1s' },
          { value: '192.0.2.3', duration: '167h59m59.5s' },
          { value: '192.0.2.4', duration: '7d' },
          { value: '192.0.2.5', duration: '-3s' },
          { value: '192.0.2.6', duration: 3600 },
        ]),
      ]);

      expect(decisions?.map((d) => [d.value, d.duration])).toEqual([
        ['192.0.2.1', '168h'],
        ['192.0.2.2', '168h'],
        ['192.0.2.3', '167h59m59.5s'],
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ maxDuration: '168h' }),
        'Capped the duration of replicated decisions'
      );
    });

    it('honours replication.max_decision_duration', async () => {
      const config = {
        ...createMockConfig([REPLICATION_TARGET]),
        replication: { max_decision_duration: '24h' },
      };
      const decisions = await replicatedDecisions(
        [alertWith([{ duration: '48h' }, { value: '192.0.2.9', duration: '4h' }])],
        config
      );

      expect(decisions?.map((d) => d.duration)).toEqual(['24h', '4h']);
    });

    it('copies only the fields a LAPI needs', async () => {
      const decisions = await replicatedDecisions([
        alertWith([
          {
            id: 42,
            uuid: 'sender-uuid',
            until: '2999-01-01T00:00:00Z',
            simulated: true,
            extra: 'ignored',
          },
        ]),
      ]);

      expect(decisions).toEqual([
        {
          type: 'ban',
          scope: 'Ip',
          value: '192.0.2.1',
          duration: '4h',
          origin: REPLICATION_ORIGIN,
          scenario: 'crowdsecurity/ssh-bf',
          simulated: true,
        },
      ]);
    });
  });

  describe('parseGoDuration', () => {
    it.each([
      ['4h', 4 * 3_600_000],
      ['1h30m', 5_400_000],
      ['3h59m58.5s', (3 * 3600 + 59 * 60 + 58.5) * 1000],
      ['1.5h', 5_400_000],
      ['250ms', 250],
      ['1us', 0.001],
      ['-12s', -12_000],
      ['0', 0],
    ])('parses %s', (input, expected) => {
      expect(parseGoDuration(input)).toBeCloseTo(expected, 6);
    });

    it.each(['', '4', '7d', 'h', '1h-30m', '4 h', ' 4h', 'abc', '1e3s'])(
      'rejects "%s"',
      (input) => {
        expect(parseGoDuration(input)).toBeNull();
      }
    );

    it('rejects non-strings', () => {
      expect(parseGoDuration(3600)).toBeNull();
      expect(parseGoDuration(undefined)).toBeNull();
    });
  });

  describe('prepareDecisionForReplication', () => {
    const limits = { maxDuration: '168h', maxDurationMs: 168 * 3_600_000 };

    it.each([null, 'ban', 42])('rejects a non-object decision (%s)', (decision) => {
      expect(prepareDecisionForReplication(decision, 's', 'o', limits)).toEqual({
        ok: false,
        reason: 'not an object',
      });
    });

    it('falls back to the alert scenario', () => {
      const check = prepareDecisionForReplication(
        { type: 'ban', scope: 'Ip', value: '192.0.2.1', duration: '1h' },
        'crowdsecurity/http-probing',
        'o',
        limits
      );
      expect(check).toMatchObject({ ok: true, decision: { scenario: 'crowdsecurity/http-probing' } });
    });

    it('rejects a range value without a prefix', () => {
      expect(
        prepareDecisionForReplication(
          { type: 'ban', scope: 'Range', value: '192.0.2.1', duration: '1h' },
          's',
          'o',
          limits
        )
      ).toEqual({ ok: false, reason: 'invalid range value' });
    });
  });
});
