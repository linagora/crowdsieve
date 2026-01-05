import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

const passthroughRoute: FastifyPluginAsync = async (fastify) => {
  const { config, proxyLogger: logger } = fastify;

  // Forward all other /v2/* requests to CAPI
  fastify.all('/v2/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const capiUrl = config.proxy.capi_url;
    const targetUrl = `${capiUrl}${request.url}`;

    logger.debug({ method: request.method, url: request.url }, 'Forwarding to CAPI');

    try {
      const headers: Record<string, string> = {};

      // Copy relevant headers
      const headersToCopy = ['authorization', 'content-type', 'user-agent', 'accept'];

      for (const header of headersToCopy) {
        const value = request.headers[header];
        if (typeof value === 'string') {
          headers[header] = value;
        }
      }

      const fetchOptions: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      };

      // Include body for POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.body) {
        fetchOptions.body = JSON.stringify(request.body);
      }

      const response = await fetch(targetUrl, fetchOptions);
      const responseBody = await response.text();

      // Forward status and headers
      reply.code(response.status);

      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      return reply.send(responseBody);
    } catch (err) {
      logger.error({ err, url: request.url }, 'Failed to forward request');
      return reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  });
};

export default passthroughRoute;
