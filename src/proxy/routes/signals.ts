import { FastifyPluginAsync } from 'fastify';
import type { SignalsRequest } from '../../models/alert.js';

const signalsRoute: FastifyPluginAsync = async (fastify) => {
  const { config, filterEngine, storage, proxyLogger: logger } = fastify;

  fastify.post<{ Body: SignalsRequest }>('/v2/signals', async (request, reply) => {
    const alerts = request.body;

    if (!Array.isArray(alerts)) {
      return reply.code(400).send({ error: 'Invalid request body: expected array' });
    }

    logger.info({ count: alerts.length }, 'Received signals batch');

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

    // Forward remaining alerts to CAPI
    try {
      const capiUrl = config.proxy.capi_url;
      const response = await fetch(`${capiUrl}/v2/signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.authorization || '',
          'User-Agent': request.headers['user-agent'] || 'crowdsieve/1.0',
        },
        body: JSON.stringify(filterResult.alerts),
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      });

      const responseBody = await response.text();

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
  });
};

export default signalsRoute;
