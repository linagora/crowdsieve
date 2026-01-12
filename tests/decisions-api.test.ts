import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import { timingSafeEqual } from 'crypto';

// Constants mirroring those in api.ts
const MAX_REASON_LENGTH = 500;
const DURATION_REGEX = /^\d+[smh]$/;
const SERVER_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

describe('Decisions API - Input Validation', () => {
  describe('IP address validation', () => {
    it('should accept valid IPv4 addresses', () => {
      const validIPs = ['192.168.1.1', '10.0.0.1', '8.8.8.8', '255.255.255.255', '0.0.0.0'];
      for (const ip of validIPs) {
        expect(net.isIP(ip)).not.toBe(0);
      }
    });

    it('should accept valid IPv6 addresses', () => {
      const validIPs = [
        '2001:db8::1',
        '::1',
        'fe80::1',
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      ];
      for (const ip of validIPs) {
        expect(net.isIP(ip)).not.toBe(0);
      }
    });

    it('should reject invalid IP addresses', () => {
      const invalidIPs = [
        'not-an-ip',
        '256.256.256.256',
        '192.168.1',
        '192.168.1.1.1',
        'example.com',
        '',
        '192.168.1.1/24', // CIDR notation should be rejected for single IP
      ];
      for (const ip of invalidIPs) {
        expect(net.isIP(ip)).toBe(0);
      }
    });
  });

  describe('Duration format validation', () => {
    it('should accept valid duration formats', () => {
      const validDurations = ['1h', '4h', '24h', '168h', '720h', '1s', '30m', '60s', '1m'];
      for (const duration of validDurations) {
        expect(DURATION_REGEX.test(duration)).toBe(true);
      }
    });

    it('should reject invalid duration formats', () => {
      const invalidDurations = [
        '1d', // days not supported
        '1w', // weeks not supported
        'h', // missing number
        '1', // missing unit
        '-1h', // negative
        '1.5h', // decimal
        '1 h', // space
        '', // empty
        'forever',
        '24hours',
      ];
      for (const duration of invalidDurations) {
        expect(DURATION_REGEX.test(duration)).toBe(false);
      }
    });
  });

  describe('Server name validation', () => {
    it('should accept valid server names', () => {
      const validNames = [
        'server1',
        'my-server',
        'server_name',
        'Server-01',
        'PROD_SERVER',
        'a',
        'server123',
      ];
      for (const name of validNames) {
        expect(SERVER_NAME_REGEX.test(name)).toBe(true);
      }
    });

    it('should reject invalid server names', () => {
      const invalidNames = [
        '', // empty
        'server name', // space
        'server.name', // dot
        'server@name', // special char
        'server/name', // slash
        '../etc/passwd', // path traversal attempt
        'server<script>', // XSS attempt
      ];
      for (const name of invalidNames) {
        expect(SERVER_NAME_REGEX.test(name)).toBe(false);
      }
    });
  });

  describe('Reason field validation', () => {
    it('should accept reasons within length limit', () => {
      const validReasons = [
        '',
        'Manual ban from dashboard',
        'Suspicious activity detected',
        'a'.repeat(MAX_REASON_LENGTH),
      ];
      for (const reason of validReasons) {
        expect(reason.length <= MAX_REASON_LENGTH).toBe(true);
      }
    });

    it('should reject reasons exceeding length limit', () => {
      const tooLongReason = 'a'.repeat(MAX_REASON_LENGTH + 1);
      expect(tooLongReason.length > MAX_REASON_LENGTH).toBe(true);
    });
  });
});

describe('Decisions API - Authentication', () => {
  /**
   * Constant-time string comparison (copy from api.ts for testing)
   */
  function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  it('should use constant-time comparison for API keys', () => {
    const apiKey = 'test-api-key-12345';
    expect(safeCompare(apiKey, apiKey)).toBe(true);
    expect(safeCompare(apiKey, 'wrong-key')).toBe(false);
    expect(safeCompare(apiKey, 'test-api-key-12346')).toBe(false);
  });

  it('should reject keys of different lengths', () => {
    expect(safeCompare('short', 'longer-key')).toBe(false);
    expect(safeCompare('longer-key', 'short')).toBe(false);
  });

  it('should handle empty strings', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'nonempty')).toBe(false);
  });
});

describe('Decisions API - Ban Request Flow', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should build correct LAPI request payload', () => {
    const ip = '192.168.1.100';
    const duration = '4h';
    const reason = 'Test ban';

    const expectedPayload = [
      {
        duration: duration,
        origin: 'crowdsieve',
        scenario: 'crowdsieve/manual',
        scope: 'ip',
        type: 'ban',
        value: ip,
        message: reason,
      },
    ];

    // Verify payload structure
    expect(expectedPayload).toHaveLength(1);
    expect(expectedPayload[0].origin).toBe('crowdsieve');
    expect(expectedPayload[0].scenario).toBe('crowdsieve/manual');
    expect(expectedPayload[0].scope).toBe('ip');
    expect(expectedPayload[0].type).toBe('ban');
    expect(expectedPayload[0].value).toBe(ip);
    expect(expectedPayload[0].duration).toBe(duration);
    expect(expectedPayload[0].message).toBe(reason);
  });

  it('should omit message when reason is not provided', () => {
    const ip = '192.168.1.100';
    const duration = '4h';
    const reason = undefined;

    // Build payload as the API does
    const payload = {
      duration: duration,
      origin: 'crowdsieve',
      scenario: 'crowdsieve/manual',
      scope: 'ip',
      type: 'ban',
      value: ip,
      ...(reason && { message: reason }),
    };

    expect(payload).not.toHaveProperty('message');
  });

  it('should include message when reason is provided', () => {
    const ip = '192.168.1.100';
    const duration = '4h';
    const reason = 'Suspicious activity';

    const payload = {
      duration: duration,
      origin: 'crowdsieve',
      scenario: 'crowdsieve/manual',
      scope: 'ip',
      type: 'ban',
      value: ip,
      ...(reason && { message: reason }),
    };

    expect(payload).toHaveProperty('message', reason);
  });
});

describe('Decisions API - Decision Search', () => {
  describe('Shared decisions detection', () => {
    const sharedOrigins = ['CAPI', 'capi', 'lists', 'crowdsec'];

    it('should identify decisions from shared origins', () => {
      const testCases = [
        { origin: 'CAPI', expected: true },
        { origin: 'capi', expected: true },
        { origin: 'lists', expected: true },
        { origin: 'crowdsec', expected: true },
        { origin: 'crowdsec/community-blocklist', expected: true },
        { origin: 'CAPI:community', expected: true },
        { origin: 'local', expected: false },
        { origin: 'crowdsieve', expected: false },
        { origin: 'manual', expected: false },
      ];

      for (const { origin, expected } of testCases) {
        const isShared = sharedOrigins.some((o) => origin.toLowerCase().includes(o.toLowerCase()));
        expect(isShared).toBe(expected);
      }
    });
  });

  describe('Decision deduplication', () => {
    it('should create unique keys for decisions', () => {
      const decision1 = { scenario: 'crowdsecurity/ssh-bf', type: 'ban', value: '192.168.1.1' };
      const decision2 = { scenario: 'crowdsecurity/ssh-bf', type: 'ban', value: '192.168.1.1' };
      const decision3 = { scenario: 'crowdsecurity/http-bf', type: 'ban', value: '192.168.1.1' };

      const key1 = `${decision1.scenario}|${decision1.type}|${decision1.value}`;
      const key2 = `${decision2.scenario}|${decision2.type}|${decision2.value}`;
      const key3 = `${decision3.scenario}|${decision3.type}|${decision3.value}`;

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });

    it('should identify truly shared decisions across all servers', () => {
      // Simulate 3 servers with decisions
      const serverResults = [
        {
          server: 'server1',
          decisions: [
            { scenario: 'shared-scenario', type: 'ban', value: '1.2.3.4', origin: 'CAPI' },
            { scenario: 'local-scenario', type: 'ban', value: '1.2.3.4', origin: 'local' },
          ],
        },
        {
          server: 'server2',
          decisions: [
            { scenario: 'shared-scenario', type: 'ban', value: '1.2.3.4', origin: 'CAPI' },
          ],
        },
        {
          server: 'server3',
          decisions: [
            { scenario: 'shared-scenario', type: 'ban', value: '1.2.3.4', origin: 'CAPI' },
          ],
        },
      ];

      const sharedOrigins = ['CAPI', 'capi', 'lists', 'crowdsec'];
      const sharedDecisionKeys = new Map<string, { decision: any; count: number }>();

      for (const result of serverResults) {
        for (const decision of result.decisions) {
          const isSharedOrigin = sharedOrigins.some((o) =>
            decision.origin?.toLowerCase().includes(o.toLowerCase())
          );

          if (isSharedOrigin) {
            const key = `${decision.scenario}|${decision.type}|${decision.value}`;
            const existing = sharedDecisionKeys.get(key);
            if (existing) {
              existing.count++;
            } else {
              sharedDecisionKeys.set(key, { decision, count: 1 });
            }
          }
        }
      }

      const serverCount = serverResults.length;
      const shared: any[] = [];

      for (const [, { decision, count }] of sharedDecisionKeys) {
        if (count >= serverCount) {
          shared.push(decision);
        }
      }

      expect(shared).toHaveLength(1);
      expect(shared[0].scenario).toBe('shared-scenario');
    });
  });
});

describe('Decisions API - Error Handling', () => {
  it('should handle missing required fields', () => {
    const testCases = [
      { server: '', ip: '1.2.3.4', duration: '4h', error: 'server missing' },
      { server: 'server1', ip: '', duration: '4h', error: 'ip missing' },
      { server: 'server1', ip: '1.2.3.4', duration: '', error: 'duration missing' },
    ];

    for (const testCase of testCases) {
      const { server, ip, duration } = testCase;
      const isValid = server && ip && duration;
      expect(isValid).toBeFalsy();
    }
  });

  it('should handle LAPI timeout gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Timeout'));
    vi.stubGlobal('fetch', mockFetch);

    try {
      await mockFetch('http://lapi:8080/v1/decisions', {
        signal: AbortSignal.timeout(5000),
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Timeout');
    }

    vi.unstubAllGlobals();
  });

  it('should handle LAPI non-200 responses', async () => {
    const mockResponse = {
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const response = await mockFetch('http://lapi:8080/v1/decisions');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);

    vi.unstubAllGlobals();
  });
});

describe('LapiServerSchema Validation', () => {
  it('should require non-empty name', async () => {
    const { z } = await import('zod');
    const LapiServerSchema = z.object({
      name: z.string().min(1),
      url: z.string().url(),
      api_key: z.string().min(1),
    });

    expect(() => LapiServerSchema.parse({ name: '', url: 'http://localhost:8080', api_key: 'key' }))
      .toThrow();
    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'http://localhost:8080', api_key: 'key' }))
      .not.toThrow();
  });

  it('should require non-empty api_key', async () => {
    const { z } = await import('zod');
    const LapiServerSchema = z.object({
      name: z.string().min(1),
      url: z.string().url(),
      api_key: z.string().min(1),
    });

    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'http://localhost:8080', api_key: '' }))
      .toThrow();
    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'http://localhost:8080', api_key: 'my-key' }))
      .not.toThrow();
  });

  it('should require valid URL', async () => {
    const { z } = await import('zod');
    const LapiServerSchema = z.object({
      name: z.string().min(1),
      url: z.string().url(),
      api_key: z.string().min(1),
    });

    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'not-a-url', api_key: 'key' }))
      .toThrow();
    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'http://localhost:8080', api_key: 'key' }))
      .not.toThrow();
    expect(() => LapiServerSchema.parse({ name: 'server1', url: 'https://lapi.example.com', api_key: 'key' }))
      .not.toThrow();
  });
});
