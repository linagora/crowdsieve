import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse, StatusResponse } from './schemas.js';

/**
 * GET /api/status: health of CAPI forwarding and of every LAPI server.
 * Registered from api.ts so it inherits the API-key authentication hook.
 */
const statusRoute: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/api/status',
    {
      schema: {
        tags: ['status'],
        summary: 'Health of CAPI forwarding and LAPI connectivity',
        description:
          'In-memory state, reset at restart. Never contains API keys, passwords or URL credentials.',
        response: {
          200: StatusResponse,
          401: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (_request, reply) => {
      const { statusService } = fastify;
      if (!statusService) {
        return reply.code(503).send({ error: 'Status service not available' });
      }
      return reply.send(statusService.getSnapshot());
    }
  );
};

export default statusRoute;
