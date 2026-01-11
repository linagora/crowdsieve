import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import net from 'net';
import { getIPInfo } from '../../ipinfo/index.js';

// Constants for input validation
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_SCENARIO_LENGTH = 200;
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;

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
};

export default apiRoutes;
