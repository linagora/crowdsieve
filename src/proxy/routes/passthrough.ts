import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

const passthroughRoute: FastifyPluginAsync = async (fastify) => {
  const { config, proxyLogger: logger } = fastify;

  // Remove default JSON parser and add raw body parser for ALL content types
  // This ensures we forward the exact bytes received without any transformation
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    ['application/json', '*'],
    { parseAs: 'buffer' },
    (_request, payload, done) => {
      done(null, payload);
    }
  );

  // Forward all /v2/* and /v3/* requests to CAPI
  const forwardToCapi = async (request: FastifyRequest, reply: FastifyReply) => {
    const capiUrl = config.proxy.capi_url;
    const targetUrl = `${capiUrl}${request.url}`;

    logger.debug({ method: request.method, url: request.url }, 'Forwarding to CAPI');

    try {
      const headers: Record<string, string> = {};

      // Copy relevant headers for proxying
      // Note: We don't forward accept-encoding to avoid compression issues
      // CAPI will send uncompressed responses which we forward as-is
      const headersToCopy = [
        'authorization',
        'content-type',
        'content-encoding', // Keep for compressed request bodies (e.g., metrics)
        'user-agent',
        'accept',
      ];

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

      // Include raw body for POST/PUT/PATCH (let fetch set Content-Length automatically)
      if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.body) {
        fetchOptions.body = request.body as Buffer;
      }

      const response = await fetch(targetUrl, fetchOptions);
      const responseBody = await response.arrayBuffer();

      // Log errors from CAPI
      if (response.status >= 400) {
        const bodyText = new TextDecoder().decode(responseBody);
        logger.warn(
          { status: response.status, url: request.url, error: bodyText },
          'CAPI returned error'
        );
      }

      // Forward status and headers
      reply.code(response.status);

      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      return reply.send(Buffer.from(responseBody));
    } catch (err) {
      logger.error({ err, url: request.url }, 'Failed to forward request');
      return reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  };

  // Register routes for both v2 and v3 CAPI endpoints
  fastify.all('/v2/*', forwardToCapi);
  fastify.all('/v3/*', forwardToCapi);
};

export default passthroughRoute;
