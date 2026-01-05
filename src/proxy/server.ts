import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config/index.js';
import type { FilterEngine } from '../filters/index.js';
import type { AlertStorage } from '../storage/index.js';
import type { Logger } from 'pino';

export interface ProxyServerDeps {
  config: Config;
  filterEngine: FilterEngine;
  storage: AlertStorage;
  logger: Logger;
}

export async function createProxyServer(deps: ProxyServerDeps): Promise<FastifyInstance> {
  const { config, filterEngine, storage, logger } = deps;

  const app = Fastify({
    logger: false, // We use our own logger
    bodyLimit: 1048576, // 1MB max request body
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
  });

  // CORS - restrictive by default
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || false,
    credentials: true,
    methods: ['GET', 'POST'],
  });

  // Decorate with dependencies
  app.decorate('config', config);
  app.decorate('filterEngine', filterEngine);
  app.decorate('storage', storage);
  app.decorate('proxyLogger', logger);

  // Request logging
  app.addHook('onRequest', async (request) => {
    logger.debug(
      {
        method: request.method,
        url: request.url,
      },
      'Incoming request'
    );
  });

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    logger.error(
      {
        err: error,
        method: request.method,
        url: request.url,
      },
      'Request error'
    );

    // Don't expose internal errors to clients
    reply.code(error.statusCode || 500).send({
      error: error.statusCode ? error.message : 'Internal Server Error',
    });
  });

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await app.register(import('./routes/api.js'));
  await app.register(import('./routes/signals.js'));
  await app.register(import('./routes/passthrough.js'));

  return app;
}

// Extend Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    filterEngine: FilterEngine;
    storage: AlertStorage;
    proxyLogger: Logger;
  }
}
