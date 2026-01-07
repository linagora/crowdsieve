import Fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config/index.js';
import type { FilterEngine } from '../filters/index.js';
import type { AlertStorage } from '../storage/index.js';
import type { Logger } from 'pino';

/**
 * Validate CORS origin - must be empty or a valid URL
 */
function validateCorsOrigin(origin: string | undefined): string | false {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    // Only allow http/https protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    return origin;
  } catch {
    return false;
  }
}

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
        imgSrc: ["'self'", 'data:'],
      },
    },
    // Enable HSTS only in production to avoid issues on non-HTTPS environments
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 60 * 60 * 24 * 180, includeSubDomains: true, preload: false }
        : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  // Rate limiting - only for external requests, not internal dashboard server
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
  const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10);
  const dashboardApiKey = process.env.DASHBOARD_API_KEY;
  if (!dashboardApiKey) {
    logger.warn(
      'DASHBOARD_API_KEY is not set; internal dashboard requests will not bypass rate limiting'
    );
  }
  await app.register(rateLimit, {
    max: isNaN(rateLimitMax) || rateLimitMax < 1 ? 100 : rateLimitMax,
    timeWindow: isNaN(rateLimitWindow) || rateLimitWindow < 1000 ? 60000 : rateLimitWindow,
    allowList: (request) => {
      const url = request.url;
      // Exclude CrowdSec CAPI passthrough routes from rate limiting
      if (!url.startsWith('/api/') && url !== '/health') {
        return true;
      }
      // Exclude requests with valid dashboard API key (internal server-to-server)
      if (dashboardApiKey) {
        // HTTP headers are case-insensitive, check both forms
        const apiKey = request.headers['x-api-key'] ?? request.headers['X-API-Key'];
        if (apiKey === dashboardApiKey) {
          return true;
        }
      }
      // In development, exclude localhost requests based on connection IP
      if (process.env.NODE_ENV !== 'production') {
        const clientIp = (request.ip || '').replace('::ffff:', '');
        if (clientIp === '127.0.0.1' || clientIp === '::1') {
          return true;
        }
      }
      return false;
    },
  });

  // CORS - restrictive by default, validate origin URL
  await app.register(cors, {
    origin: validateCorsOrigin(process.env.CORS_ORIGIN),
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

  // CAPI passthrough hook - forwards /v2/* and /v3/* requests to CAPI
  // except /v2/signals which has its own handler with filtering logic
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;

    // Only intercept /v2/* and /v3/* routes
    if (!url.startsWith('/v2/') && !url.startsWith('/v3/')) {
      return; // Let other routes handle this
    }

    // Skip /v2/signals and /v3/signals - they have their own handler with filtering logic
    if (
      url === '/v2/signals' ||
      url.startsWith('/v2/signals?') ||
      url === '/v3/signals' ||
      url.startsWith('/v3/signals?')
    ) {
      return; // Let the signals route handle this
    }

    const capiUrl = config.proxy.capi_url;
    const targetUrl = `${capiUrl}${url}`;

    logger.debug({ method: request.method, url }, 'Forwarding to CAPI');

    try {
      const headers: Record<string, string> = {};

      // Copy relevant headers for proxying
      const headersToCopy = [
        'authorization',
        'content-type',
        'content-encoding',
        'user-agent',
        'accept',
      ];

      for (const header of headersToCopy) {
        const value = request.headers[header];
        if (typeof value === 'string') {
          headers[header] = value;
        }
      }

      // Read raw body for POST/PUT/PATCH
      let body: Buffer | undefined;
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const chunks: Buffer[] = [];
        for await (const chunk of request.raw) {
          chunks.push(chunk as Buffer);
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const fetchOptions: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      };

      if (body) {
        fetchOptions.body = body;
      }

      const response = await fetch(targetUrl, fetchOptions);
      const responseBody = await response.arrayBuffer();

      // Log errors from CAPI
      if (response.status >= 400) {
        const bodyText = new TextDecoder().decode(responseBody);
        logger.warn({ status: response.status, url, error: bodyText }, 'CAPI returned error');
      }

      // Forward status and headers
      reply.code(response.status);

      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      reply.send(Buffer.from(responseBody));
    } catch (err) {
      logger.error({ err, url }, 'Failed to forward request');
      reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  });

  // Global error handler
  app.setErrorHandler((error: FastifyError, request, reply) => {
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
