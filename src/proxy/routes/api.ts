import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import net from 'net';
import { getIPInfo } from '../../ipinfo/index.js';
import type { LapiServer } from '../../config/index.js';

// Constants for input validation
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_SCENARIO_LENGTH = 200;
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;
const DURATION_REGEX = /^\d+[smh]$/;

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const apiRoutes: FastifyPluginAsync = async (fastify) => {
  const { storage, proxyLogger: logger } = fastify;

  // API key authentication hook
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const configuredKey = process.env.DASHBOARD_API_KEY;

    // No API key configured = development mode (allow all)
    if (!configuredKey) return;

    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || !safeCompare(apiKey, configuredKey)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Get alerts
  fastify.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      filtered?: string;
      scenario?: string;
      country?: string;
      machineId?: string;
      since?: string;
      until?: string;
    };
  }>('/api/alerts', async (request, reply) => {
    try {
      // Input validation with bounds
      const rawLimit = parseInt(request.query.limit || String(DEFAULT_LIMIT), 10);
      const rawOffset = parseInt(request.query.offset || '0', 10);

      const limit = Math.min(Math.max(isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, 1), MAX_LIMIT);
      const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);

      // Validate country code format (ISO 3166-1 alpha-2)
      const country = request.query.country;
      if (country && !COUNTRY_CODE_REGEX.test(country)) {
        return reply.code(400).send({ error: 'Invalid country code format' });
      }

      // Validate scenario length to prevent abuse
      const scenario = request.query.scenario;
      if (scenario && scenario.length > MAX_SCENARIO_LENGTH) {
        return reply.code(400).send({ error: 'Scenario filter too long' });
      }

      // Parse and validate date parameters
      let since: Date | undefined;
      let until: Date | undefined;

      // Reasonable date bounds: not before 2020, not more than 1 day in the future
      const minAllowedDate = new Date('2020-01-01T00:00:00Z');
      const maxAllowedDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      if (request.query.since) {
        since = new Date(request.query.since);
        if (isNaN(since.getTime())) {
          return reply.code(400).send({ error: 'Invalid since date format' });
        }
        if (since < minAllowedDate || since > maxAllowedDate) {
          return reply.code(400).send({ error: 'Since date out of acceptable range' });
        }
      }

      if (request.query.until) {
        until = new Date(request.query.until);
        if (isNaN(until.getTime())) {
          return reply.code(400).send({ error: 'Invalid until date format' });
        }
        if (until < minAllowedDate || until > maxAllowedDate) {
          return reply.code(400).send({ error: 'Until date out of acceptable range' });
        }
      }

      const query = {
        limit,
        offset,
        filtered: request.query.filtered ? request.query.filtered === 'true' : undefined,
        scenario,
        sourceCountry: country,
        machineId: request.query.machineId,
        since,
        until,
      };

      const alerts = await storage.queryAlerts(query);
      return reply.send(alerts);
    } catch (err) {
      logger.error({ err }, 'Failed to query alerts');
      return reply.code(500).send({ error: 'Failed to query alerts' });
    }
  });

  // Get single alert
  fastify.get<{
    Params: { id: string };
  }>('/api/alerts/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);

      // Validate ID is a positive integer
      if (isNaN(id) || id < 1) {
        return reply.code(400).send({ error: 'Invalid alert ID' });
      }

      const alert = await storage.getAlertById(id);

      if (!alert) {
        return reply.code(404).send({ error: 'Alert not found' });
      }

      return reply.send(alert);
    } catch (err) {
      logger.error({ err }, 'Failed to get alert');
      return reply.code(500).send({ error: 'Failed to get alert' });
    }
  });

  // Get stats
  fastify.get('/api/stats', async (request, reply) => {
    try {
      const stats = await storage.getStats();
      return reply.send(stats);
    } catch (err) {
      logger.error({ err }, 'Failed to get stats');
      return reply.code(500).send({ error: 'Failed to get stats' });
    }
  });

  // Get IP info (reverse DNS + WHOIS)
  fastify.get<{
    Params: { ip: string };
  }>('/api/ip-info/:ip', async (request, reply) => {
    try {
      const { ip } = request.params;

      // Validate IP address using Node's net module (handles IPv4 and IPv6 correctly)
      if (!net.isIP(ip)) {
        return reply.code(400).send({ error: 'Invalid IP address format' });
      }

      const ipInfo = await getIPInfo(ip);

      if (ipInfo.error) {
        return reply.code(400).send({ error: ipInfo.error });
      }

      return reply.send(ipInfo);
    } catch (err) {
      logger.error({ err }, 'Failed to get IP info');
      return reply.code(500).send({ error: 'Failed to get IP info' });
    }
  });

  // Get configured LAPI servers (without exposing API keys)
  fastify.get('/api/lapi-servers', async (request, reply) => {
    try {
      const { config } = fastify;
      const servers = (config.lapi_servers || []).map((s: LapiServer) => ({
        name: s.name,
        url: s.url,
      }));
      return reply.send(servers);
    } catch (err) {
      logger.error({ err }, 'Failed to get LAPI servers');
      return reply.code(500).send({ error: 'Failed to get LAPI servers' });
    }
  });

  // Search decisions for an IP across all LAPI servers
  fastify.get<{
    Querystring: { ip: string };
  }>('/api/decisions', async (request, reply) => {
    try {
      const { ip } = request.query;

      // Validate IP
      if (!ip || !net.isIP(ip)) {
        return reply.code(400).send({ error: 'Invalid or missing IP address' });
      }

      const { config } = fastify;
      const servers = config.lapi_servers || [];

      if (servers.length === 0) {
        return reply.send({ ip, results: [], shared: [] });
      }

      // Query all LAPI servers in parallel
      const serverResults = await Promise.all(
        servers.map(async (server: LapiServer) => {
          try {
            const lapiUrl = `${server.url}/v1/decisions?ip=${encodeURIComponent(ip)}`;
            const response = await fetch(lapiUrl, {
              headers: {
                'X-Api-Key': server.api_key,
              },
              signal: AbortSignal.timeout(config.proxy.timeout_ms),
            });

            if (!response.ok) {
              const errorBody = await response.text();
              logger.warn(
                { server: server.name, status: response.status, error: errorBody },
                'LAPI returned error when querying decisions'
              );
              return {
                server: server.name,
                decisions: [] as Array<{
                  id: number;
                  origin: string;
                  type: string;
                  scope: string;
                  value: string;
                  duration: string;
                  scenario: string;
                  until?: string;
                }>,
                error: `LAPI error: ${response.status}`,
              };
            }

            const decisions = await response.json();
            return {
              server: server.name,
              decisions: (decisions || []) as Array<{
                id: number;
                origin: string;
                type: string;
                scope: string;
                value: string;
                duration: string;
                scenario: string;
                until?: string;
              }>,
            };
          } catch (err) {
            logger.warn({ server: server.name, err }, 'Failed to query LAPI for decisions');
            return {
              server: server.name,
              decisions: [] as Array<{
                id: number;
                origin: string;
                type: string;
                scope: string;
                value: string;
                duration: string;
                scenario: string;
                until?: string;
              }>,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        })
      );

      // Separate shared decisions (from CAPI/lists) that appear on all servers
      // from local decisions specific to each server
      const sharedOrigins = ['CAPI', 'capi', 'lists', 'crowdsec'];
      const sharedDecisionKeys = new Map<
        string,
        { decision: (typeof serverResults)[0]['decisions'][0]; count: number }
      >();
      const localResults: typeof serverResults = [];

      // First pass: identify potentially shared decisions
      for (const result of serverResults) {
        const localDecisions: typeof result.decisions = [];

        for (const decision of result.decisions) {
          // Check if this decision comes from a shared/central source
          const isSharedOrigin = sharedOrigins.some((o) =>
            decision.origin?.toLowerCase().includes(o.toLowerCase())
          );

          if (isSharedOrigin) {
            // Create a unique key for this decision (scenario + type + value)
            const key = `${decision.scenario}|${decision.type}|${decision.value}`;
            const existing = sharedDecisionKeys.get(key);
            if (existing) {
              existing.count++;
            } else {
              sharedDecisionKeys.set(key, { decision, count: 1 });
            }
          } else {
            localDecisions.push(decision);
          }
        }

        localResults.push({
          server: result.server,
          decisions: localDecisions,
          error: result.error,
        });
      }

      // Extract decisions that appear on ALL servers (truly shared)
      const serverCount = serverResults.filter((r) => !r.error).length;
      const shared: Array<(typeof serverResults)[0]['decisions'][0]> = [];

      for (const [key, { decision, count }] of sharedDecisionKeys) {
        if (count >= serverCount && serverCount > 0) {
          // This decision appears on all working servers - it's shared
          shared.push(decision);
        } else {
          // This decision doesn't appear everywhere - add it back to individual servers
          for (const result of localResults) {
            const serverResult = serverResults.find((r) => r.server === result.server);
            if (serverResult) {
              const hasDecision = serverResult.decisions.some(
                (d) => `${d.scenario}|${d.type}|${d.value}` === key
              );
              if (hasDecision) {
                result.decisions.push(decision);
              }
            }
          }
        }
      }

      logger.info(
        { ip, serverCount: servers.length, sharedCount: shared.length },
        'Queried decisions across LAPI servers'
      );
      return reply.send({ ip, results: localResults, shared });
    } catch (err) {
      logger.error({ err }, 'Failed to search decisions');
      return reply.code(500).send({ error: 'Failed to search decisions' });
    }
  });

  // Post a manual ban decision to a LAPI server
  fastify.post<{
    Body: {
      server: string;
      ip: string;
      duration: string;
      reason?: string;
    };
  }>('/api/decisions/ban', async (request, reply) => {
    try {
      const { server, ip, duration, reason } = request.body;

      // Validate required fields
      if (!server || !ip || !duration) {
        return reply.code(400).send({ error: 'Missing required fields: server, ip, duration' });
      }

      // Validate IP address
      if (!net.isIP(ip)) {
        return reply.code(400).send({ error: 'Invalid IP address format' });
      }

      // Validate duration format
      if (!DURATION_REGEX.test(duration)) {
        return reply
          .code(400)
          .send({ error: 'Invalid duration format. Use format like: 4h, 24h, 168h' });
      }

      // Find the LAPI server
      const { config } = fastify;
      const lapiServer = (config.lapi_servers || []).find((s: LapiServer) => s.name === server);
      if (!lapiServer) {
        return reply.code(404).send({ error: 'LAPI server not found' });
      }

      // Build the decision payload for CrowdSec LAPI
      const decisionPayload = [
        {
          duration: duration,
          origin: 'crowdsieve',
          scenario: 'crowdsieve/manual',
          scope: 'ip',
          type: 'ban',
          value: ip,
          ...(reason && { message: reason }),
        },
      ];

      // Post to LAPI
      const lapiUrl = `${lapiServer.url}/v1/decisions`;
      logger.info({ server: lapiServer.name, ip, duration }, 'Posting manual ban decision to LAPI');

      const response = await fetch(lapiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': lapiServer.api_key,
        },
        body: JSON.stringify(decisionPayload),
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, error: errorBody, server: lapiServer.name },
          'LAPI rejected decision'
        );
        return reply.code(response.status).send({
          error: `LAPI returned error: ${response.status}`,
          details: errorBody,
        });
      }

      const result = await response.json();
      logger.info(
        { server: lapiServer.name, ip, result },
        'Manual ban decision posted successfully'
      );

      return reply.send({
        success: true,
        message: `IP ${ip} banned for ${duration}`,
        server: lapiServer.name,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to post ban decision');
      return reply.code(500).send({ error: 'Failed to post ban decision' });
    }
  });
};

export default apiRoutes;
