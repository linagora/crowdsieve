import { Type } from 'typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  ErrorResponse,
  NotificationTargetName,
  NotificationTestResponse,
  NotificationsResponse,
} from './schemas.js';

const DISABLED_SNAPSHOT = { enabled: false, dashboardUrl: null, targets: [] };

/**
 * GET /api/notifications: the configured targets and their last delivery.
 * POST /api/notifications/:name/test: send a test message to a target.
 *
 * Registered from api.ts so it inherits the API-key authentication hook.
 * Neither route ever returns a target URL (only its host) nor its headers.
 */
const notificationRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/api/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Notification targets and their last delivery result',
        description:
          'In-memory state, reset at restart. Never contains target URLs (only their host) or headers.',
        response: {
          200: NotificationsResponse,
          401: ErrorResponse,
        },
      },
    },
    async (_request, reply) => {
      const { notificationService } = fastify;
      return reply.send(
        notificationService ? notificationService.getSnapshot() : DISABLED_SNAPSHOT
      );
    }
  );

  fastify.post(
    '/api/notifications/:name/test',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Send a test message to a notification target',
        description:
          'Delivers "CrowdSieve test notification from <dashboard_url>" once, without retry. ' +
          'A delivery failure is answered with 200 and ok=false.',
        params: Type.Object({ name: NotificationTargetName }),
        response: {
          200: NotificationTestResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { notificationService } = fastify;
      const result = notificationService
        ? await notificationService.sendTest(request.params.name)
        : null;
      if (!result) {
        return reply.code(404).send({ error: 'Notification target not found' });
      }
      if (result.throttled) {
        return reply.code(429).send({ error: result.message });
      }
      return reply.send({ ok: result.ok, message: result.message });
    }
  );
};

export default notificationRoutes;
