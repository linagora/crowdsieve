import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createReplicationService, ReplicationService, ReplicationLogger, REPLICATION_ORIGIN } from '../src/replication/index.js';
import type { Config } from '../src/config/index.js';
import type { Alert } from '../src/models/alert.js';
import { clearTokenCache } from '../src/auth/machineToken.js';

// Mock fetch - stubbed in beforeEach
const mockFetch = vi.fn();

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
    lapi_servers: lapiServers,
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
      enabled: false,
      interval_seconds: 300,
      retention_days: 30,
      request_timeout_ms: 10000,
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

      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions(alerts);

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
      await service.replicateDecisions(alerts, 'lapi-sender-id');

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
        await service.replicateDecisions(alerts, sourceMachine);
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
      await service.replicateDecisions(alerts, 'machine-a');

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

      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions(alerts);

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
      await service.replicateDecisions(alerts);

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
      await service.replicateDecisions(alerts);

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
      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions(alerts);

      // Should skip without fetching token because no replicable decisions after filtering
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(logger.debug).toHaveBeenCalledWith(
        { server: 'server1' },
        'No replicable decisions after filtering (all from crowdsieve origin)'
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

      await service.replicateDecisions(alerts);

      // Should skip without fetching token because no replicable decisions after filtering
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(logger.debug).toHaveBeenCalledWith(
        { server: 'server1' },
        'No replicable decisions after filtering (all from crowdsieve origin)'
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

      await service.replicateDecisions(alerts);

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

      await service.replicateDecisions([alertWithMissingFields]);

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
});
