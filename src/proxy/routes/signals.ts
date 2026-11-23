import { FastifyRequest, FastifyReply } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { SignalsRequest, Alert } from '../../models/alert.js';
import type { ValidationResult } from '../../validation/index.js';
import type { ReplicationSender } from '../../replication/index.js';
import { extractJwtMachineId } from '../../auth/jwt.js';
import {
  ErrorResponse,
  ErrorWithMessageResponse,
  SignalsBody,
  SignalsResponse,
} from './schemas.js';

/** CAPI answers meaning that forwarding does not work (credentials, quota, outage). */
export function isCapiFailureStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 429;
}

// Maximum number of alerts allowed per batch to prevent DoS
export const MAX_ALERTS_PER_BATCH = 1000;

// Origins that should NOT be forwarded to CAPI (to prevent loops)
// Only filter 'crowdsieve-replication' (auto-replicated decisions)
// Manual decisions with origin 'crowdsieve' should be forwarded to CAPI
export const CROWDSIEVE_ORIGINS: readonly string[] = Object.freeze(['crowdsieve-replication']);

/**
 * Collect the machine_id values the alerts claim to come from (the CrowdSec
 * agents behind the sending LAPI). Attacker-controlled: only used by the
 * replication service to exclude more targets, never to authorize anything.
 */
function extractReportedMachineIds(alerts: SignalsRequest): string[] {
  const ids = new Set<string>();
  for (const alert of alerts) {
    if (typeof alert.machine_id === 'string' && alert.machine_id.length > 0) {
      ids.add(alert.machine_id);
    }
  }
  return [...ids];
}

/**
 * Check if an alert has decisions from crowdsieve-replication origin (should not be forwarded to CAPI)
 * Returns true if ANY decision is from crowdsieve-replication origin (to prevent loop)
 * Manual decisions with origin 'crowdsieve' are allowed through
 */
export function isCrowdsieveAlert(alert: Alert): boolean {
  // The signals schema accepts any object: `decisions` may be a non-array
  // value even though the Alert type declares an array.
  const decisions = alert.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return false;
  }

  // Check if any decision is from crowdsieve origins (prevent any crowdsieve decisions reaching CAPI)
  return decisions.some((decision) => {
    if (!decision || typeof decision !== 'object') return false;
    const origin = typeof decision.origin === 'string' ? decision.origin.toLowerCase() : '';
    return CROWDSIEVE_ORIGINS.some((excluded) => origin.includes(excluded.toLowerCase()));
  });
}

/**
 * Filter out alerts that originated from crowdsieve (to prevent loops with CAPI)
 * These alerts should be stored and replicated but NOT forwarded to CAPI
 */
function filterCrowdsieveAlerts(alerts: Alert[]): { alerts: Alert[]; filteredCount: number } {
  const filtered = alerts.filter((alert) => !isCrowdsieveAlert(alert));
  return {
    alerts: filtered,
    filteredCount: alerts.length - filtered.length,
  };
}

const signalsRoute: FastifyPluginAsyncTypebox = async (fastify) => {
  const {
    config,
    filterEngine,
    storage,
    proxyLogger: logger,
    clientValidator,
    replicationService,
    statusService,
  } = fastify;

  /**
   * Establish who sent a batch, for replication purposes.
   *
   * Reuses the request's validation result when client validation is
   * enabled; otherwise validates the Authorization header against CAPI now
   * (the validator is always created when replication is configured), without
   * affecting the response. The machine id is read from the JWT only when CAPI
   * authenticated that exact header (a real 2xx, not a fail-open).
   */
  async function resolveReplicationSender(
    authHeader: string | undefined,
    validation: ValidationResult | undefined
  ): Promise<Omit<ReplicationSender, 'reportedMachineIds'>> {
    let result = validation;
    if (!result) {
      if (!clientValidator) {
        return { authenticated: false, reason: 'no_validator' };
      }
      result = await clientValidator.validate(authHeader);
    }
    if (!result.authenticated) {
      return { authenticated: false, reason: result.reason };
    }
    return { authenticated: true, machineId: extractJwtMachineId(authHeader) };
  }

  // Shared handler for both /v2/signals and /v3/signals
  const handleSignals = async (
    request: FastifyRequest<{ Body: SignalsRequest }>,
    reply: FastifyReply,
    apiVersion: 'v2' | 'v3'
  ) => {
    // attachValidation: true — inspect validation errors before Fastify auto-rejects
    if (request.validationError) {
      const msg = request.validationError.message || '';
      if (/maxItems|must NOT have more than/.test(msg)) {
        logger.warn(
          {
            count: Array.isArray(request.body) ? request.body.length : undefined,
            max: MAX_ALERTS_PER_BATCH,
            clientIp: request.ip,
          },
          'Rejected oversized alerts batch'
        );
        return reply
          .code(413)
          .send({ error: `Batch too large: maximum ${MAX_ALERTS_PER_BATCH} alerts per request` });
      }
      return reply.code(400).send({ error: msg });
    }

    logger.debug(
      { method: request.method, url: request.url, clientIp: request.ip },
      'Incoming request'
    );

    const authHeader = request.headers.authorization;

    // Client validation (if enabled)
    let validation: ValidationResult | undefined;
    if (config.client_validation?.enabled) {
      if (!clientValidator) {
        logger.error('Client validation enabled but clientValidator not initialized');
        return reply.code(500).send({ error: 'Internal server error' });
      }

      const result = await clientValidator.validate(authHeader);
      validation = result;

      if (!result.valid) {
        logger.warn(
          { reason: result.reason, clientIp: request.ip },
          'Rejected signals from invalid client'
        );
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Client validation failed',
        });
      }

      logger.info({ reason: result.reason, clientIp: request.ip }, 'Client validated');
    }

    // Body shape (array, max 1000 items) is validated by the schema.
    const alerts = request.body;

    logger.info({ count: alerts.length, apiVersion }, 'Received signals batch');
    logger.debug({ incomingBody: JSON.stringify(alerts) }, 'Incoming alerts (raw)');

    // Process through filter engine
    const filterResult = filterEngine.process(alerts);

    logger.info(
      {
        original: filterResult.originalCount,
        filtered: filterResult.filteredCount,
        passed: filterResult.passedCount,
      },
      'Filter results'
    );

    // Store all alerts (both filtered and passed) for dashboard
    // Note: Alerts with crowdsieve-replication origin are automatically skipped by storage
    let replicableIndices: number[] = [];
    try {
      const storeResult = await storage.storeAlerts(alerts, filterResult.filterDetails, {
        logger,
      });
      replicableIndices = storeResult.replicableIndices;
    } catch (err) {
      logger.error({ err }, 'Failed to store alerts');
      // Don't fail the request - storage is secondary
    }

    // Replicate decisions to LAPI servers asynchronously (non-blocking)
    // We replicate ALL original alerts with decisions, regardless of filtering,
    // but only from a sender authenticated against CAPI whose JWT machine id
    // is trusted (checked by the replication service).
    if (replicationService && replicableIndices.length > 0) {
      const reportedMachineIds = extractReportedMachineIds(alerts);
      setImmediate(async () => {
        try {
          const sender = await resolveReplicationSender(authHeader, validation);
          const outcome = await replicationService.replicateDecisions(alerts, {
            ...sender,
            reportedMachineIds,
          });
          // Mark alerts as replicated only after replication went through
          if (outcome !== 'refused') {
            await storage.markAlertsReplicated(replicableIndices);
          }
        } catch (err) {
          logger.error({ err }, 'Failed to replicate decisions');
        }
      });
    }

    // If all alerts were filtered, return success without forwarding
    if (filterResult.alerts.length === 0) {
      logger.info('All alerts filtered, not forwarding to CAPI');
      return reply.code(200).send({ message: 'OK' });
    }

    // Filter out crowdsieve-originated alerts (prevent loops with CAPI)
    const crowdsieveFilterResult = filterCrowdsieveAlerts(filterResult.alerts);
    if (crowdsieveFilterResult.filteredCount > 0) {
      logger.info(
        { filtered: crowdsieveFilterResult.filteredCount },
        'Filtered crowdsieve-originated alerts (not forwarding to CAPI)'
      );
    }

    // If all remaining alerts are from crowdsieve, don't forward
    if (crowdsieveFilterResult.alerts.length === 0) {
      logger.info('All alerts are crowdsieve-originated, not forwarding to CAPI');
      return reply.code(200).send({ message: 'OK' });
    }

    // Check if forwarding is disabled (test mode)
    if (!config.proxy.forward_enabled) {
      logger.info(
        { count: crowdsieveFilterResult.alerts.length },
        'Forwarding disabled, alerts stored but not sent to CAPI'
      );
      return reply.code(200).send({ message: 'OK (forwarding disabled)' });
    }

    // Forward remaining alerts to CAPI (using same API version as incoming request)
    try {
      const capiUrl = config.proxy.capi_url;
      const outgoingBody = JSON.stringify(crowdsieveFilterResult.alerts);
      logger.debug({ outgoingBody }, 'Outgoing alerts to CAPI');
      // Forward all headers except hop-by-hop headers that shouldn't be proxied.
      // Also drop `content-encoding` and `accept-encoding`: Fastify already
      // gunzipped the request body for us and we re-serialize as plain JSON
      // below — keeping an inbound `Content-Encoding: gzip` would make CAPI
      // try to gunzip a plain JSON payload and reject it with 415.
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
      };

      for (const [key, value] of Object.entries(request.headers)) {
        const lowerKey = key.toLowerCase();
        if (!headersToSkip.has(lowerKey) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }

      logger.debug({ forwardHeaders: Object.keys(forwardHeaders) }, 'Forwarding headers to CAPI');

      const response = await fetch(`${capiUrl}/${apiVersion}/signals`, {
        method: 'POST',
        headers: forwardHeaders,
        body: outgoingBody,
        signal: AbortSignal.timeout(config.proxy.timeout_ms),
      });

      const responseBody = await response.text();

      // Health tracking: CAPI rejecting our credentials, throttling or failing
      // counts as a forwarding failure, any other answer as a success.
      if (isCapiFailureStatus(response.status)) {
        statusService?.recordCapiFailure(
          crowdsieveFilterResult.alerts.length,
          new Error(`CAPI answered HTTP ${response.status}`)
        );
      } else {
        statusService?.recordCapiSuccess(crowdsieveFilterResult.alerts.length);
      }

      logger.info(
        { count: crowdsieveFilterResult.alerts.length, status: response.status, apiVersion },
        'Forwarded signals to CAPI'
      );
      logger.debug({ responseBody }, 'CAPI response body');

      // Update storage with forwarded status
      try {
        await storage.markAlertsForwarded(
          filterResult.filterDetails.filter((d) => !d.filtered).map((d) => d.alertIndex)
        );
      } catch (err) {
        logger.error({ err }, 'Failed to update forwarded status');
      }

      // Forward CAPI response back to LAPI
      reply.code(response.status);

      // Forward relevant headers
      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      return reply.send(responseBody);
    } catch (err) {
      logger.error({ err }, 'Failed to forward to CAPI');
      statusService?.recordCapiFailure(crowdsieveFilterResult.alerts.length, err);
      return reply.code(502).send({ error: 'Failed to forward to CAPI' });
    }
  };

  // Schema metadata is shared between v2 and v3 routes; the body type provider
  // gives us a permissive Array<object> capped at MAX_ALERTS_PER_BATCH items.
  const signalsRouteOpts = {
    attachValidation: true,
    schema: {
      tags: ['signals'],
      summary: 'Forward CrowdSec signals to CAPI after filtering',
      description:
        'Receives a batch of CrowdSec alerts, runs them through the configured filters, ' +
        'stores them locally, replicates relevant decisions to LAPI servers, and forwards ' +
        'non-filtered, non-loop alerts to the upstream CAPI.',
      body: SignalsBody,
      response: {
        200: SignalsResponse,
        400: ErrorResponse,
        401: ErrorWithMessageResponse,
        413: ErrorResponse,
        500: ErrorResponse,
        502: ErrorResponse,
      },
    },
  };

  // Register routes for both API versions
  fastify.post('/v2/signals', signalsRouteOpts, (request, reply) =>
    handleSignals(request as FastifyRequest<{ Body: SignalsRequest }>, reply, 'v2')
  );

  fastify.post('/v3/signals', signalsRouteOpts, (request, reply) =>
    handleSignals(request as FastifyRequest<{ Body: SignalsRequest }>, reply, 'v3')
  );
};

export default signalsRoute;
