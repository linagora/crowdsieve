/**
 * Standalone script that boots a minimal Fastify instance, registers all route
 * plugins with @fastify/swagger, then writes the resulting OpenAPI spec to
 * openapi.json at the repository root.
 *
 * Usage:
 *   npm run openapi:generate
 *
 * This script is only executed in development / CI; it is NOT imported by the
 * production server. @fastify/swagger lives in devDependencies.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createRequire } from 'module';
import { HealthResponse } from '../src/proxy/routes/schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

// Read version from package.json
const require = createRequire(import.meta.url);
const { version: CROWDSIEVE_VERSION } = require('../package.json') as { version: string };

async function generate(): Promise<void> {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();

  // Stub decorators — handlers never run during schema collection, but the
  // plugin bodies destructure these at registration time.
  app.decorate('config', {
    lapi_servers: [],
    proxy: { capi_url: '', timeout_ms: 1000, forward_enabled: false },
  } as never);
  app.decorate('storage', {} as never);
  app.decorate('proxyLogger', {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never);
  app.decorate('filterEngine', {} as never);
  app.decorate('clientValidator', undefined);
  app.decorate('replicationService', undefined);

  // Register swagger BEFORE routes so the schema collector picks up every
  // route's `schema` block.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CrowdSieve API',
        description:
          'CrowdSec CAPI filtering proxy — internal management API + signals passthrough.',
        version: CROWDSIEVE_VERSION,
      },
      components: {
        securitySchemes: {
          ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
      security: [{ ApiKey: [] }],
    },
  });

  // Health check (mirrored from server.ts)
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Returns the proxy status and current server timestamp.',
        response: {
          200: HealthResponse,
        },
      },
    },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() })
  );

  // Register the same route plugins as server.ts
  await app.register(import('../src/proxy/routes/api.js'));
  await app.register(import('../src/proxy/routes/signals.js'));

  await app.ready();

  // app.swagger() is the synchronous accessor exposed by @fastify/swagger
  const spec = app.swagger();

  const outPath = join(repoRoot, 'openapi.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  const pathCount = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length;
  console.log(`OpenAPI spec written to ${outPath}`);
  console.log(`  version : ${CROWDSIEVE_VERSION}`);
  console.log(`  paths   : ${pathCount}`);

  await app.close();
  process.exit(0);
}

generate().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
