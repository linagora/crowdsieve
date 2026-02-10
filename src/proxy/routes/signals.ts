import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { SignalsRequest } from '../../models/alert.js';

// Maximum number of alerts allowed per batch to prevent DoS
export const MAX_ALERTS_PER_BATCH = 1000;

const signalsRoute: FastifyPluginAsync = async (fastify) => {
  const { config, filterEngine, storage, proxyLogger: logger, clientValidator } = fastify;

  // Shared handler for both /v2/signals and /v3/signals
  const handleSignals = async (
    request: FastifyRequest<{ Body: SignalsRequest }>,
    reply: FastifyReply,
    apiVersion: 'v2' | 'v3'
  ) => {
    logger.debug(
      { method: request.method, url: request.url, clientIp: request.ip },
      'Incoming request'
    );

    // Client validation (if enabled)
    if (config.client_validation?.enabled) {
      if (!clientValidator) {
        logger.error('Client validation enabled but clientValidator not initialized');
        return reply.code(500).send({ error: 'Internal server error' });
      }

      const result = await clientValidator.validate(request.headers.authorization);

      if (!result.valid) {
        logger.warn(
          { reason: result.reason, clientIp: request.ip },
          'Rejected signals from invalid client'
        );
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Client validation failed',
        });
      }

      logger.info({ reason: result.reason, clientIp: request.ip }, 'Client validated');
    }

    const alerts = request.body;

    if (!Array.isArray(alerts)) {
      return reply.code(400).send({ error: 'Invalid request body: expected array' });
    }

    // Limit batch size to prevent DoS
    if (alerts.length > MAX_ALERTS_PER_BATCH) {
      logger.warn(
        { count: alerts.length, max: MAX_ALERTS_PER_BATCH, clientIp: request.ip },
        'Rejected oversized alerts batch'
      );
      return reply.code(413).send({
        error: `Batch too large: maximum ${MAX_ALERTS_PER_BATCH} alerts per request`,
      });
    }

    logger.info({ count: alerts.length, apiVersion }, 'Received signals batch');
    logger.debug({ incomingBody: JSON.stringify(alerts) }, 'Incoming alerts (raw)');

    // Process through filter engine
    const filterResult = filterEngine.process(alerts);

    logger.info(
      {
        original: filterResult.originalCount,
        filtered: filterResult.filteredCount,
        passed: filterResult.passedCount,
      },
      'Filter results'
    );

    // Store all alerts (both filtered and passed) for dashboard
    try {
      await storage.storeAlerts(alerts, filterResult.filterDetails);
    } catch (err) {
      logger.error({ err }, 'Failed to store alerts');
      // Don't fail the request - storage is secondary
    }

    // If all alerts were filtered, return success without forwarding
    if (filterResult.alerts.length === 0) {
      logger.info('All alerts filtered, not forwarding to CAPI');
      return reply.code(200).send({ message: 'OK' });
    }

    // Check if forwarding is disabled (test mode)
    if (!config.proxy.forward_enabled) {
      logger.info(
        { count: filterResult.alerts.length },
        'Forwarding disabled, alerts stored but not sent to CAPI'
      );
      return reply.code(200).send({ message: 'OK (forwarding disabled)' });
    }

    // Forward remaining alerts to CAPI (using same API version as incoming request)
    try {
      const capiUrl = config.proxy.capi_url;
      const outgoingBody = JSON.stringify(filterResult.alerts);
      logger.debug({ outgoingBody }, 'Outgoing alerts to CAPI');
      // Forward all headers except hop-by-hop headers that shouldn't be proxied
      const headersToSkip = new Set([
        'host',
        'connection',
        'keep-alive',
        'transfer-encoding',
        'content-length',
        'te',
        'trailer',
        'upgrade',
      ]);

      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      for (const [key, value] of Object.entries(request.headers)) {
        const lowerKey = key.toLowerCase();
        if (!headersToSkip.has(lowerKey) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }

      logger.debug({ forwardHeaders: Object.keys(forwardHeaders) }, 'Forwarding headers to CAPI');

      const response = await fetch(`${capiUrl}/${apiVersion}/signals`, {
        method: 'POST',
        headers: forwardHeaders,
        body: outgoingBody,
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      });

      const responseBody = await response.text();

      logger.info(
        { count: filterResult.alerts.length, status: response.status, apiVersion },
        'Forwarded signals to CAPI'
      );
      logger.debug({ responseBody }, 'CAPI response body');

      // Update storage with forwarded status
      try {
        await storage.markAlertsForwarded(
          filterResult.filterDetails.filter((d) => !d.filtered).map((d) => d.alertIndex)
        );
      } catch (err) {
        logger.error({ err }, 'Failed to update forwarded status');
      }

      // Forward CAPI response back to LAPI
      reply.code(response.status);

      // Forward relevant headers
      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      return reply.send(responseBody);
    } catch (err) {
      logger.error({ err }, 'Failed to forward to CAPI');
      return reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  };

  // Register routes for both API versions
  fastify.post<{ Body: SignalsRequest }>('/v2/signals', (request, reply) =>
    handleSignals(request, reply, 'v2')
  );

  fastify.post<{ Body: SignalsRequest }>('/v3/signals', (request, reply) =>
    handleSignals(request, reply, 'v3')
  );
};

export default signalsRoute;
