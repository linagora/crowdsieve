import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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
  });

  // Enable CORS for dashboard API access
  await app.register(cors, {
    origin: true,
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
