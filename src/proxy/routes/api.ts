import { FastifyPluginAsync } from 'fastify';

const apiRoutes: FastifyPluginAsync = async (fastify) => {
  const { storage, proxyLogger: logger } = fastify;

  // Get alerts
  fastify.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      filtered?: string;
      scenario?: string;
      country?: string;
    };
  }>('/api/alerts', async (request, reply) => {
    try {
      const query = {
        limit: request.query.limit ? parseInt(request.query.limit, 10) : 100,
        offset: request.query.offset ? parseInt(request.query.offset, 10) : 0,
        filtered: request.query.filtered ? request.query.filtered === 'true' : undefined,
        scenario: request.query.scenario,
        sourceCountry: request.query.country,
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
};

export default apiRoutes;
