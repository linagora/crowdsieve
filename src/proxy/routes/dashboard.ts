import { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dashboardRoute: FastifyPluginAsync = async (fastify) => {
  const { proxyLogger: logger } = fastify;

  // Possible dashboard build locations
  const possiblePaths = [
    join(__dirname, '../../../dashboard/out'), // Development: next export
    join(__dirname, '../../../dashboard/.next/static'), // Development: next build
    join(process.cwd(), 'dashboard/out'), // Production: exported
    join(process.cwd(), 'dashboard-static'), // Docker: copied static files
  ];

  let staticPath: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      staticPath = p;
      break;
    }
  }

  if (staticPath) {
    logger.info({ path: staticPath }, 'Serving dashboard static files');

    // Serve static files for dashboard
    await fastify.register(fastifyStatic, {
      root: staticPath,
      prefix: '/_next/static/',
      decorateReply: false,
    });
  }

  // For Next.js standalone mode, we need to proxy to the Next.js server
  // In production with static export, we serve HTML files directly
  const outPath = join(process.cwd(), 'dashboard/out');
  const standaloneMode = !existsSync(outPath);

  if (standaloneMode) {
    // Proxy dashboard requests to Next.js server (if running separately for dev)
    fastify.get('/dashboard', async (_request, reply) => {
      return reply.redirect('/');
    });

    // Note: In production Docker, we'll use static export instead
    logger.info('Dashboard in standalone mode - use npm run dev:dashboard for development');
  } else {
    // Serve static HTML files from Next.js export
    await fastify.register(fastifyStatic, {
      root: outPath,
      prefix: '/',
      decorateReply: true,
      index: ['index.html'],
    });

    logger.info({ path: outPath }, 'Serving dashboard from static export');
  }
};

export default dashboardRoute;
