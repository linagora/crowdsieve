/**
 * Route handler for POST /v1/usage-metrics and POST /v3/usage-metrics.
 * (LAPI->CAPI uses v3, bouncers->LAPI use v1; we capture both.)
 *
 * CrowdSec LAPI relays bouncer/log-processor metrics to CAPI by POSTing this
 * endpoint. CrowdSieve sits between LAPI and CAPI as the configured CAPI proxy
 * URL, so this traffic naturally passes through us. We:
 *
 *   1. Parse the payload.
 *   2. Persist per-bouncer rows via {@link AlertStorage.saveBouncerMetrics}.
 *      This is done before forwarding so a CAPI outage doesn't lose metrics.
 *   3. Forward the original body to the upstream CAPI when
 *      `config.proxy.forward_enabled` is true (mirrors signals.ts).
 *
 * Auth follows the same pattern as `/v2/signals` and `/v3/signals`: when
 * `config.client_validation.enabled` we run the bearer token through
 * `clientValidator.validate`; otherwise the request is accepted as-is and
 * forwarded upstream (CAPI itself does the real auth check, identical to the
 * pre-existing CAPI passthrough hook).
 *
 * The `lapiServerName` column for the persisted rows is derived from the
 * machine_id encoded in the JWT bearer token. The request body does not
 * contain a LAPI identifier, and using the JWT subject keeps rows tied to the
 * actual sender even if we have no matching `lapi_servers[]` entry locally.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { buildRowsFromPayload, type UsageMetricsPayload } from '../../metrics/parse.js';

const gzipAsync = promisify(gzip);
import {
  ErrorResponse,
  ErrorWithMessageResponse,
  SuccessResponse,
  UsageMetricsBody,
} from './schemas.js';

/**
 * Best-effort decode of the `id` (machine_id) claim from a CrowdSec machine
 * JWT. The LAPI -> CAPI traffic always carries one in the `Authorization`
 * header. We do NOT verify the signature: CAPI is the source of truth for that
 * (and our own `clientValidator` already takes that role when enabled).
 *
 * Returns `'unknown'` when the header is missing or malformed — the row still
 * gets persisted, just bucketed under that fallback name. This keeps data
 * collection robust to occasional CrowdSec format changes.
 */
function extractMachineIdFromAuth(authHeader: string | undefined): string {
  if (!authHeader) return 'unknown';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = m ? m[1] : authHeader.trim();
  const parts = token.split('.');
  if (parts.length < 2) return 'unknown';
  try {
    // JWT payload is base64url
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    // CrowdSec emits `id` for machine tokens.
    const id = obj.id ?? obj.machine_id ?? obj.sub;
    if (typeof id === 'string' && id.length > 0) return id;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const usageMetricsRoute: FastifyPluginAsyncTypebox = async (fastify) => {
  const { config, storage, proxyLogger: logger, clientValidator } = fastify;

  // Build a reverse-lookup map from JWT machine_id → friendly LAPI server name.
  // Populated from `lapi_servers[].source_machine_ids` — the same field used for
  // loop-prevention so the configuration is self-consistent.
  const machineIdToServerName = new Map<string, string>();
  for (const server of config.lapi_servers ?? []) {
    for (const mid of server.source_machine_ids ?? []) {
      machineIdToServerName.set(mid, server.name);
    }
  }

  const handle = async (
    request: FastifyRequest<{ Body: UsageMetricsPayload }>,
    reply: FastifyReply
  ) => {
    if (request.validationError) {
      return reply.code(400).send({ error: request.validationError.message || 'Invalid request' });
    }

    // Optional client validation, identical to /v2/signals.
    if (config.client_validation?.enabled) {
      if (!clientValidator) {
        logger.error('Client validation enabled but clientValidator not initialized');
        return reply.code(500).send({ error: 'Internal server error' });
      }
      const result = await clientValidator.validate(request.headers.authorization);
      if (!result.valid) {
        logger.warn(
          { reason: result.reason, clientIp: request.ip },
          'Rejected usage-metrics from invalid client'
        );
        return reply.code(401).send({ error: 'Unauthorized', message: 'Client validation failed' });
      }
    }

    // Even when client_validation is off we still want to refuse anonymous
    // posts: this endpoint is only meaningful for authenticated LAPI relays.
    // Lack of an Authorization header is the simplest signal of that.
    if (!request.headers.authorization) {
      return reply
        .code(401)
        .send({ error: 'Unauthorized', message: 'Missing Authorization header' });
    }

    const body = request.body ?? {};
    const rawMachineId = extractMachineIdFromAuth(request.headers.authorization);
    const lapiServerName = machineIdToServerName.get(rawMachineId) ?? rawMachineId;
    const rows = buildRowsFromPayload(lapiServerName, body, Date.now());

    // Persist before forwarding so a CAPI outage cannot drop metrics. A DB
    // failure must NOT 500 the request — CrowdSec retries the relay on its
    // own cycle and we don't want to break community telemetry over a hiccup.
    if (rows.length > 0) {
      try {
        await storage.saveBouncerMetrics(rows);
        logger.debug(
          { rows: rows.length, machineId: rawMachineId, lapiServerName },
          'Persisted bouncer metrics from intercepted usage-metrics POST'
        );
      } catch (err) {
        logger.error(
          { err, rows: rows.length, machineId: rawMachineId, lapiServerName },
          'Failed to persist bouncer metrics'
        );
      }
    }

    // No upstream forwarding (test mode): respond 201 like a generic accept.
    if (!config.proxy.forward_enabled) {
      logger.info({ rows: rows.length }, 'Forwarding disabled, usage-metrics stored only');
      return reply.code(201).send({ success: true });
    }

    // Forward to CAPI. We rebuild the body from `request.body` (already
    // parsed) rather than re-streaming the raw request because Fastify has
    // consumed the underlying stream by now.
    try {
      const capiUrl = config.proxy.capi_url;
      // Gzip the outgoing body. CrowdSec LAPI normally sends usage-metrics
      // gzipped (highly repetitive JSON compresses 5-10×); Fastify gunzipped
      // it on the way in. CAPI enforces a 10 MiB wire-size limit, so we MUST
      // re-compress on the way out — otherwise a payload that arrived 2 MiB
      // gzipped becomes 15-20 MiB plain and gets rejected with 413.
      const outgoingJson = JSON.stringify(body);
      const outgoing = await gzipAsync(outgoingJson);

      // Mirror signals.ts: forward all headers except hop-by-hop ones.
      // We set `Content-Encoding: gzip` ourselves below, so we drop the
      // inbound one (we just re-encoded the body). Same idea for
      // `accept-encoding` — let fetch negotiate.
      const headersToSkip = new Set([
        'host',
        'connection',
        'keep-alive',
        'transfer-encoding',
        'content-length',
        'content-encoding',
        'accept-encoding',
        'te',
        'trailer',
        'upgrade',
      ]);
      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      };
      for (const [key, value] of Object.entries(request.headers)) {
        const lowerKey = key.toLowerCase();
        if (!headersToSkip.has(lowerKey) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }

      const response = await fetch(`${capiUrl}${request.url}`, {
        method: 'POST',
        headers: forwardHeaders,
        body: outgoing,
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      });

      const responseBody = await response.text();
      logger.info(
        { rows: rows.length, status: response.status, machineId: rawMachineId, lapiServerName },
        'Forwarded usage-metrics to CAPI'
      );

      reply.code(response.status);
      const contentType = response.headers.get('content-type');
      if (contentType) reply.header('content-type', contentType);
      return reply.send(responseBody);
    } catch (err) {
      logger.error({ err }, 'Failed to forward usage-metrics to CAPI');
      return reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  };

  const routeOpts = {
    attachValidation: true,
    // CrowdSec LAPI relays accumulated bouncer/agent metrics every ~30 min
    // and the body can easily exceed the 1 MiB default (especially after a
    // CAPI outage where multiple cycles backlog).
    bodyLimit: 50 * 1024 * 1024,
    schema: {
      tags: ['metrics'],
      summary: 'Intercept CrowdSec LAPI -> CAPI usage-metrics relay',
      description:
        'Receives the usage-metrics payload that CrowdSec LAPI POSTs to its ' +
        'configured CAPI URL, persists per-bouncer counters locally, then ' +
        'forwards the same body upstream to the real CAPI when forwarding is ' +
        'enabled. Auth and forwarding behavior mirror /v2/signals.',
      body: UsageMetricsBody,
      response: {
        201: SuccessResponse,
        400: ErrorResponse,
        401: ErrorWithMessageResponse,
        500: ErrorResponse,
        502: ErrorResponse,
      },
    },
  };

  // CrowdSec LAPI uses URLPrefix "v3" when talking to CAPI
  // (pkg/apiserver/apic.go), and bouncers post to "/v1/usage-metrics" on a
  // LAPI directly. We register both so that whichever client lands on the
  // CrowdSieve proxy port is captured.
  for (const path of ['/v1/usage-metrics', '/v3/usage-metrics']) {
    fastify.post(path, routeOpts, (request, reply) =>
      handle(request as FastifyRequest<{ Body: UsageMetricsPayload }>, reply)
    );
  }
};

export default usageMetricsRoute;
