import { FastifyRequest, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { timingSafeEqual, createHash } from 'crypto';
import net from 'net';
import { getIPInfo, extractIpFromValue } from '../../ipinfo/index.js';
import type { LapiServer } from '../../config/index.js';
import { getAnalyzerEngine } from '../../analyzers/index.js';
import { getMachineToken, CROWDSIEVE_VERSION } from '../../auth/machineToken.js';
import {
  AlertResponse,
  AnalyzerDetailResponse,
  AnalyzerRunTriggerResponse,
  AnalyzerRunsResponse,
  AnalyzersListResponse,
  CountryCode,
  DecisionStatsResponse,
  DecisionsResponse,
  Duration,
  ErrorResponse,
  IPInfoResponse,
  IsoDate,
  LapiServerInfo,
  MachineId,
  Period,
  ServerName,
  StatsResponse,
  SuccessResponse,
  TimeDistributionResponse,
} from './schemas.js';

// Constants kept for tests and OpenAPI metadata. Values are replicated in the
// route schemas (maxLength, regex, etc.) so the regexes here remain the
// single source of truth used by the test suite.
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_SCENARIO_LENGTH = 200;

// Exported constants for use in tests
export const MAX_REASON_LENGTH = 500;
export const MAX_MACHINE_ID_LENGTH = 255;
export const MAX_ACTOR_LENGTH = 256;
export const DURATION_REGEX = /^\d+[smh]$/;
export const SERVER_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
export const MACHINE_ID_REGEX = /^[a-zA-Z0-9_\-.:]+$/;

/**
 * Read the X-Crowdsieve-Actor header propagated by the dashboard proxy.
 * Returns null when the header is missing, empty/whitespace-only, or coerces
 * to no usable value. Truncates to MAX_ACTOR_LENGTH defensively. Multi-value
 * headers are flattened to the first non-empty entry.
 */
export function extractActorHeader(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_ACTOR_LENGTH);
}

/**
 * Validate and parse an IP address or CIDR notation
 * Returns { valid: true, scope: 'ip'|'range', value: string } or { valid: false }
 */
export function parseIpOrCidr(
  input: string
): { valid: true; scope: 'ip' | 'range'; value: string } | { valid: false } {
  const trimmed = input.trim();

  // Check for CIDR notation (contains /)
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) {
      return { valid: false };
    }
    const [ip, prefix] = parts;
    const prefixNum = parseInt(prefix, 10);

    // Validate IPv4 CIDR
    if (net.isIPv4(ip)) {
      if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) {
        return { valid: false };
      }
      return { valid: true, scope: 'range', value: trimmed };
    }

    // Validate IPv6 CIDR
    if (net.isIPv6(ip)) {
      if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) {
        return { valid: false };
      }
      return { valid: true, scope: 'range', value: trimmed };
    }

    return { valid: false };
  }

  // Check for single IP
  if (net.isIP(trimmed)) {
    return { valid: true, scope: 'ip', value: trimmed };
  }

  return { valid: false };
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const apiRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const { storage, proxyLogger: logger } = fastify;

  // API key authentication hook
  // DASHBOARD_API_KEY is always set (generated at startup if not provided)
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const configuredKey = process.env.DASHBOARD_API_KEY;

    // This should never happen as key is generated at startup, but fail secure
    if (!configuredKey) {
      return reply.code(500).send({ error: 'Server misconfiguration: API key not set' });
    }

    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || !safeCompare(apiKey, configuredKey)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Reasonable date bounds: not before 2020, not more than 1 day in the future.
  // Schema validates `format: date-time` parseability; this enforces semantic bounds.
  const minAllowedDate = new Date('2020-01-01T00:00:00Z');
  const checkDateInRange = (d: Date): boolean => {
    const maxAllowedDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return d >= minAllowedDate && d <= maxAllowedDate;
  };

  // Get alerts
  fastify.get(
    '/api/alerts',
    {
      schema: {
        tags: ['alerts'],
        summary: 'List alerts with filters',
        querystring: Type.Object({
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
          ),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
          filtered: Type.Optional(Type.Boolean()),
          forwardedToCapi: Type.Optional(Type.Boolean()),
          scenario: Type.Optional(Type.String({ maxLength: MAX_SCENARIO_LENGTH })),
          country: Type.Optional(CountryCode),
          machineId: Type.Optional(MachineId),
          ip: Type.Optional(Type.String()),
          since: Type.Optional(IsoDate),
          until: Type.Optional(IsoDate),
          newerThan: Type.Optional(IsoDate),
        }),
        response: {
          200: Type.Array(AlertResponse),
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const {
          limit = DEFAULT_LIMIT,
          offset = 0,
          filtered,
          forwardedToCapi,
          scenario,
          country,
          machineId,
          ip,
          since: sinceStr,
          until: untilStr,
          newerThan: newerThanStr,
        } = request.query;

        // Schema can't validate IP semantics — net.isIP handles v4 and v6.
        if (ip && !net.isIP(ip)) {
          return reply.code(400).send({ error: 'Invalid IP address format' });
        }

        // Schema validates date parseability via format; we still need
        // semantic bounds (year >= 2020, not more than 1 day in the future).
        let since: Date | undefined;
        let until: Date | undefined;
        let newerThan: Date | undefined;

        if (sinceStr) {
          since = new Date(sinceStr);
          if (isNaN(since.getTime())) {
            return reply.code(400).send({ error: 'Invalid since date format' });
          }
          if (!checkDateInRange(since)) {
            return reply.code(400).send({ error: 'Since date out of acceptable range' });
          }
        }

        if (untilStr) {
          until = new Date(untilStr);
          if (isNaN(until.getTime())) {
            return reply.code(400).send({ error: 'Invalid until date format' });
          }
          if (!checkDateInRange(until)) {
            return reply.code(400).send({ error: 'Until date out of acceptable range' });
          }
        }

        if (newerThanStr) {
          newerThan = new Date(newerThanStr);
          if (isNaN(newerThan.getTime())) {
            return reply.code(400).send({ error: 'Invalid newerThan date format' });
          }
          if (!checkDateInRange(newerThan)) {
            return reply.code(400).send({ error: 'newerThan date out of acceptable range' });
          }

          // Optimization: if no alerts are newer than the timestamp the
          // dashboard already saw, skip the full query and return [].
          const hasNewer = await storage.hasAlertsNewerThan(newerThan);
          if (!hasNewer) {
            return reply.send([]);
          }
        }

        const query = {
          limit,
          offset,
          filtered,
          forwardedToCapi,
          scenario,
          sourceCountry: country,
          sourceIp: ip,
          machineId,
          since,
          until,
        };

        const alerts = await storage.queryAlerts(query);
        return reply.send(alerts);
      } catch (err) {
        logger.error({ err }, 'Failed to query alerts');
        return reply.code(500).send({ error: 'Failed to query alerts' });
      }
    }
  );

  // Get single alert
  fastify.get(
    '/api/alerts/:id',
    {
      schema: {
        tags: ['alerts'],
        summary: 'Get a single alert by ID',
        params: Type.Object({
          id: Type.Integer({ minimum: 1 }),
        }),
        response: {
          200: AlertResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;

        const alert = await storage.getAlertById(id);

        if (!alert) {
          return reply.code(404).send({ error: 'Alert not found' });
        }

        return reply.send(alert);
      } catch (err) {
        logger.error({ err }, 'Failed to get alert');
        return reply.code(500).send({ error: 'Failed to get alert' });
      }
    }
  );

  // Get stats
  fastify.get(
    '/api/stats',
    {
      schema: {
        tags: ['stats'],
        summary: 'Get aggregate alert statistics',
        response: {
          200: StatsResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const stats = await storage.getStats();
        return reply.send(stats);
      } catch (err) {
        logger.error({ err }, 'Failed to get stats');
        return reply.code(500).send({ error: 'Failed to get stats' });
      }
    }
  );

  // Get time distribution statistics
  fastify.get(
    '/api/stats/distribution',
    {
      schema: {
        tags: ['stats'],
        summary: 'Get time distribution statistics',
        querystring: Type.Object({
          period: Period,
        }),
        response: {
          200: TimeDistributionResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { period } = request.query;
        let since: Date | undefined;

        // Calculate since date based on period
        if (period === '7d') {
          since = new Date();
          since.setDate(since.getDate() - 7);
        } else if (period === '30d' || !period) {
          since = new Date();
          since.setDate(since.getDate() - 30);
        }
        // period === 'all' means no since filter

        const stats = await storage.getTimeDistributionStats(since);
        return reply.send(stats);
      } catch (err) {
        logger.error({ err }, 'Failed to get distribution stats');
        return reply.code(500).send({ error: 'Failed to get distribution stats' });
      }
    }
  );

  // Get decision statistics
  fastify.get(
    '/api/stats/decisions',
    {
      schema: {
        tags: ['stats'],
        summary: 'Get decision statistics',
        querystring: Type.Object({
          period: Period,
        }),
        response: {
          200: DecisionStatsResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { period } = request.query;
        let since: Date | undefined;

        // Calculate since date based on period
        if (period === '7d') {
          since = new Date();
          since.setDate(since.getDate() - 7);
        } else if (period === '30d' || !period) {
          since = new Date();
          since.setDate(since.getDate() - 30);
        }
        // period === 'all' means no since filter

        const stats = await storage.getDecisionStats(since);
        return reply.send(stats);
      } catch (err) {
        logger.error({ err }, 'Failed to get decision stats');
        return reply.code(500).send({ error: 'Failed to get decision stats' });
      }
    }
  );

  // Get IP info (reverse DNS + WHOIS)
  fastify.get(
    '/api/ip-info/:ip',
    {
      schema: {
        tags: ['ip-info'],
        summary: 'Get reverse DNS and WHOIS info for an IP',
        params: Type.Object({
          // Permissive: handler still validates with net.isIP after stripping CIDR.
          ip: Type.String({ minLength: 1, maxLength: 64 }),
        }),
        response: {
          200: IPInfoResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { ip } = request.params;

        // Extract base IP if this is a CIDR range
        const baseIp = extractIpFromValue(ip);

        // Validate IP address using Node's net module (handles IPv4 and IPv6 correctly)
        if (!net.isIP(baseIp)) {
          return reply.code(400).send({ error: 'Invalid IP address format' });
        }

        const ipInfo = await getIPInfo(ip);

        if (ipInfo.error) {
          return reply.code(400).send({ error: ipInfo.error });
        }

        return reply.send(ipInfo);
      } catch (err) {
        logger.error({ err }, 'Failed to get IP info');
        return reply.code(500).send({ error: 'Failed to get IP info' });
      }
    }
  );

  // Get configured LAPI servers (without exposing API keys)
  fastify.get(
    '/api/lapi-servers',
    {
      schema: {
        tags: ['lapi'],
        summary: 'List configured LAPI servers',
        response: {
          200: Type.Array(LapiServerInfo),
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { config } = fastify;
        const servers = (config.lapi_servers || []).map((s: LapiServer) => ({
          name: s.name,
          url: s.url,
          canBan: Boolean(s.machine_id && s.password), // True if machine credentials are configured
        }));
        return reply.send(servers);
      } catch (err) {
        logger.error({ err }, 'Failed to get LAPI servers');
        return reply.code(500).send({ error: 'Failed to get LAPI servers' });
      }
    }
  );

  // Search decisions for an IP across all LAPI servers
  fastify.get(
    '/api/decisions',
    {
      schema: {
        tags: ['decisions'],
        summary: 'Search decisions for an IP across all configured LAPI servers',
        querystring: Type.Object({
          ip: Type.String({ minLength: 1 }),
        }),
        response: {
          200: DecisionsResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { ip } = request.query;

        // Validate IP or CIDR — schema can't reliably validate CIDR.
        const parsed = parseIpOrCidr(ip);
        if (!parsed.valid) {
          return reply.code(400).send({ error: 'Invalid IP address or CIDR format' });
        }
        const normalizedIp = parsed.value;

        const { config } = fastify;
        const servers = config.lapi_servers || [];

        if (servers.length === 0) {
          return reply.send({ ip: normalizedIp, results: [], shared: [] });
        }

        // Query all LAPI servers in parallel
        const serverResults = await Promise.all(
          servers.map(async (server: LapiServer) => {
            try {
              const lapiUrl = `${server.url}/v1/decisions?ip=${encodeURIComponent(normalizedIp)}`;
              const response = await fetch(lapiUrl, {
                headers: {
                  'X-Api-Key': server.api_key,
                  'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
                },
                signal: AbortSignal.timeout(config.proxy.timeout_ms),
              });

              if (!response.ok) {
                const errorBody = await response.text();
                logger.warn(
                  { server: server.name, status: response.status, error: errorBody },
                  'LAPI returned error when querying decisions'
                );
                return {
                  server: server.name,
                  decisions: [] as Array<{
                    id: number;
                    origin: string;
                    type: string;
                    scope: string;
                    value: string;
                    duration: string;
                    scenario: string;
                    until?: string;
                  }>,
                  error: `LAPI error: ${response.status}`,
                };
              }

              const decisions = await response.json();
              return {
                server: server.name,
                decisions: (decisions || []) as Array<{
                  id: number;
                  origin: string;
                  type: string;
                  scope: string;
                  value: string;
                  duration: string;
                  scenario: string;
                  until?: string;
                }>,
              };
            } catch (err) {
              logger.warn({ server: server.name, err }, 'Failed to query LAPI for decisions');
              return {
                server: server.name,
                decisions: [] as Array<{
                  id: number;
                  origin: string;
                  type: string;
                  scope: string;
                  value: string;
                  duration: string;
                  scenario: string;
                  until?: string;
                }>,
                error: err instanceof Error ? err.message : 'Unknown error',
              };
            }
          })
        );

        // Separate shared decisions (from CAPI/lists) that appear on all servers
        // from local decisions specific to each server
        // Note: 'crowdsec' origin means local agent detection, not shared CAPI decisions
        const sharedOrigins = ['CAPI', 'capi', 'lists'];
        const sharedDecisionKeys = new Map<
          string,
          { decision: (typeof serverResults)[0]['decisions'][0]; count: number }
        >();
        const localResults: typeof serverResults = [];

        // First pass: identify potentially shared decisions
        for (const result of serverResults) {
          const localDecisions: typeof result.decisions = [];

          for (const decision of result.decisions) {
            // Check if this decision comes from a shared/central source
            const isSharedOrigin = sharedOrigins.some((o) =>
              decision.origin?.toLowerCase().includes(o.toLowerCase())
            );

            if (isSharedOrigin) {
              // Create a unique key for this decision (scenario + type + value)
              const key = `${decision.scenario}|${decision.type}|${decision.value}`;
              const existing = sharedDecisionKeys.get(key);
              if (existing) {
                existing.count++;
              } else {
                sharedDecisionKeys.set(key, { decision, count: 1 });
              }
            } else {
              localDecisions.push(decision);
            }
          }

          localResults.push({
            server: result.server,
            decisions: localDecisions,
            error: result.error,
          });
        }

        // Extract decisions that appear on ALL servers (truly shared)
        const serverCount = serverResults.filter((r) => !r.error).length;
        const shared: Array<(typeof serverResults)[0]['decisions'][0]> = [];

        for (const [key, { decision, count }] of sharedDecisionKeys) {
          if (count >= serverCount && serverCount > 0) {
            // This decision appears on all working servers - it's shared
            shared.push(decision);
          } else {
            // This decision doesn't appear everywhere - add it back to individual servers
            for (const result of localResults) {
              const serverResult = serverResults.find((r) => r.server === result.server);
              if (serverResult) {
                // Find the server-specific decision to preserve server-specific fields (id, until, etc.)
                const serverSpecificDecision = serverResult.decisions.find(
                  (d) => `${d.scenario}|${d.type}|${d.value}` === key
                );
                if (serverSpecificDecision) {
                  result.decisions.push(serverSpecificDecision);
                }
              }
            }
          }
        }

        logger.info(
          { ip: normalizedIp, serverCount: servers.length, sharedCount: shared.length },
          'Queried decisions across LAPI servers'
        );
        return reply.send({ ip: normalizedIp, results: localResults, shared });
      } catch (err) {
        logger.error({ err }, 'Failed to search decisions');
        return reply.code(500).send({ error: 'Failed to search decisions' });
      }
    }
  );

  // Post a manual ban decision to a LAPI server using machine credentials
  // This uses POST /v1/alerts with embedded decisions for immediate effect
  fastify.post(
    '/api/decisions/ban',
    {
      schema: {
        tags: ['decisions'],
        summary: 'Issue a manual ban decision via a LAPI server',
        body: Type.Object({
          server: ServerName,
          ip: Type.String({ minLength: 1 }),
          duration: Duration,
          reason: Type.String({ minLength: 1, maxLength: MAX_REASON_LENGTH }),
        }),
        response: {
          200: SuccessResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
          502: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        // Authentication for all /api/* routes, including this one, is enforced by the
        // plugin-wide onRequest API key hook before the handler is reached.

        const { server, ip, duration, reason } = request.body;

        // Validate IP address or CIDR — schema can't reliably validate CIDR.
        const parsed = parseIpOrCidr(ip);
        if (!parsed.valid) {
          return reply.code(400).send({ error: 'Invalid IP address or CIDR format' });
        }
        const { scope: targetScope, value: targetValue } = parsed;

        // Schema enforces presence and minLength: 1, but a whitespace-only value
        // (e.g. "   ") passes the schema. Reject it with a specific message.
        const trimmedReason = reason.trim();
        if (trimmedReason.length === 0) {
          return reply
            .code(400)
            .send({ error: 'Invalid reason: must not be blank or whitespace-only' });
        }

        // Optional actor header forwarded by the dashboard from the OIDC session.
        // Threaded through the alert payload's events[].meta so it survives the
        // LAPI -> signals roundtrip and lands in the alerts.actor column when
        // the manual ban alert comes back through the signals path.
        const actor = extractActorHeader(request.headers['x-crowdsieve-actor']);

        // Find the LAPI server
        const { config } = fastify;
        const lapiServer = (config.lapi_servers || []).find((s: LapiServer) => s.name === server);
        if (!lapiServer) {
          return reply.code(404).send({ error: 'LAPI server not found' });
        }

        // Check if machine credentials are configured
        if (!lapiServer.machine_id || !lapiServer.password) {
          return reply.code(400).send({
            error:
              'Machine credentials not configured for this server. Manual banning requires machine_id and password.',
          });
        }

        // Get machine token
        const token = await getMachineToken(lapiServer, config.proxy.timeout_ms, logger);
        if (!token) {
          return reply.code(500).send({ error: 'Failed to authenticate with LAPI' });
        }

        // Build the alert payload with embedded decision (like LemonLDAP does)
        const timestamp = new Date().toISOString();
        const scenario = 'crowdsieve/manual';
        const scenarioHash = createHash('sha256').update(scenario).digest('hex');
        const message = trimmedReason;

        const alertPayload = [
          {
            scenario,
            scenario_hash: scenarioHash,
            scenario_version: CROWDSIEVE_VERSION,
            message,
            events_count: 1,
            start_at: timestamp,
            stop_at: timestamp,
            capacity: 1,
            leakspeed: '1s',
            simulated: false,
            remediation: true,
            source: {
              scope: targetScope,
              value: targetValue,
            },
            events: [
              {
                timestamp,
                meta: [
                  { key: 'source', value: 'crowdsieve-dashboard' },
                  { key: 'reason', value: message },
                  // Conditionally include the actor so unauthenticated callers
                  // (no OIDC session) don't end up with a literal empty value.
                  ...(actor ? [{ key: 'actor', value: actor }] : []),
                ],
                source: {
                  scope: targetScope,
                  value: targetValue,
                },
              },
            ],
            decisions: [
              {
                duration,
                type: 'ban',
                scope: targetScope,
                value: targetValue,
                origin: 'crowdsieve',
                scenario,
              },
            ],
          },
        ];

        // Post to LAPI /v1/alerts
        const lapiUrl = `${lapiServer.url}/v1/alerts`;
        logger.info(
          { server: lapiServer.name, target: targetValue, scope: targetScope, duration },
          'Posting manual ban alert to LAPI'
        );

        const response = await fetch(lapiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `crowdsieve/${CROWDSIEVE_VERSION}`,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(alertPayload),
          signal: AbortSignal.timeout(config.proxy.timeout_ms),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.error(
            { status: response.status, error: errorBody, server: lapiServer.name },
            'LAPI rejected alert'
          );
          // Don't expose raw LAPI error details to client - could contain sensitive info.
          // Map upstream status to a known declared response code to match the schema.
          const upstreamStatus = response.status;
          const mappedStatus =
            upstreamStatus === 400 ||
            upstreamStatus === 401 ||
            upstreamStatus === 403 ||
            upstreamStatus === 404 ||
            upstreamStatus === 500
              ? upstreamStatus
              : 502;
          return reply.code(mappedStatus).send({
            error: `LAPI returned error: ${upstreamStatus}`,
          });
        }

        const result = await response.json();
        logger.info(
          { server: lapiServer.name, target: targetValue, scope: targetScope, result },
          'Manual ban alert posted successfully'
        );

        return reply.send({
          success: true,
          message: `${targetValue} banned for ${duration}`,
          server: lapiServer.name,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to post ban alert');
        return reply.code(500).send({ error: 'Failed to post ban alert' });
      }
    }
  );

  // Delete a decision from a LAPI server using machine credentials
  // Note: CSRF protection is not needed here because:
  // 1. This endpoint requires API key authentication (already checked by preHandler)
  // 2. Requests come from the Next.js dashboard proxy (server-to-server)
  // 3. The dashboard proxy already handles browser CSRF via same-origin policy
  fastify.delete(
    '/api/decisions/:id',
    {
      schema: {
        tags: ['decisions'],
        summary: 'Delete a decision from a LAPI server',
        params: Type.Object({
          id: Type.Integer({ minimum: 1 }),
        }),
        querystring: Type.Object({
          server: ServerName,
        }),
        // The dashboard must supply a non-empty `reason` (audit trail) and the
        // target `ip` (or CIDR) so we can record a local unban event. DELETE
        // bodies are supported in Fastify 4+.
        body: Type.Object({
          reason: Type.String({ minLength: 1, maxLength: MAX_REASON_LENGTH }),
          ip: Type.String({ minLength: 1 }),
        }),
        response: {
          200: SuccessResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
          502: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id: decisionId } = request.params;
        const { server } = request.query;
        const { reason, ip } = request.body;

        // Trim and reject whitespace-only reasons (schema only enforces minLength).
        const trimmedReason = reason.trim();
        if (trimmedReason.length === 0) {
          return reply
            .code(400)
            .send({ error: 'Invalid reason: must not be blank or whitespace-only' });
        }

        // Validate IP / CIDR — schema only enforces non-empty.
        const parsed = parseIpOrCidr(ip);
        if (!parsed.valid) {
          return reply.code(400).send({ error: 'Invalid IP address or CIDR format' });
        }

        // Optional actor header forwarded by the dashboard from the OIDC session.
        // Used purely for audit trail; missing/blank values do not block deletion.
        const actor = extractActorHeader(request.headers['x-crowdsieve-actor']);

        // Find the LAPI server
        const { config } = fastify;
        const lapiServer = (config.lapi_servers || []).find((s: LapiServer) => s.name === server);
        if (!lapiServer) {
          return reply.code(404).send({ error: 'LAPI server not found' });
        }

        // Check if machine credentials are configured
        if (!lapiServer.machine_id || !lapiServer.password) {
          return reply.code(400).send({
            error:
              'Machine credentials not configured for this server. Deleting decisions requires machine_id and password.',
          });
        }

        // Get machine token
        const token = await getMachineToken(lapiServer, config.proxy.timeout_ms, logger);
        if (!token) {
          return reply.code(500).send({ error: 'Failed to authenticate with LAPI' });
        }

        // Delete the decision via LAPI
        const deleteUrl = `${lapiServer.url}/v1/decisions/${decisionId}`;
        logger.info(
          { server: lapiServer.name, decisionId, url: deleteUrl },
          'Deleting decision from LAPI'
        );

        const response = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(config.proxy.timeout_ms),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.error(
            { status: response.status, error: errorBody, server: lapiServer.name },
            'LAPI rejected delete request'
          );
          if (response.status === 404) {
            return reply.code(404).send({ error: 'Decision not found' });
          }
          // Map upstream status to a known declared response code to match the schema.
          const upstreamStatus = response.status;
          const mappedStatus =
            upstreamStatus === 400 ||
            upstreamStatus === 401 ||
            upstreamStatus === 404 ||
            upstreamStatus === 500
              ? upstreamStatus
              : 502;
          return reply.code(mappedStatus).send({
            error: `LAPI returned error: ${upstreamStatus}`,
          });
        }

        logger.info({ server: lapiServer.name, decisionId }, 'Decision deleted successfully');

        // Record a local unban event for audit & timeline visibility.
        // Failures here must not bubble: the LAPI delete already succeeded.
        try {
          await storage.recordUnbanEvent({
            ip: parsed.value,
            scope: parsed.scope,
            comment: trimmedReason,
            server: lapiServer.name,
            decisionId,
            actor,
          });
        } catch (recordErr) {
          logger.error(
            { err: recordErr, server: lapiServer.name, decisionId },
            'Failed to record unban event (LAPI delete already succeeded)'
          );
        }

        return reply.send({
          success: true,
          message: `Decision ${decisionId} deleted`,
          server: lapiServer.name,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to delete decision');
        return reply.code(500).send({ error: 'Failed to delete decision' });
      }
    }
  );

  // ============== Analyzer API Endpoints ==============

  // Get list of analyzers and their status
  fastify.get(
    '/api/analyzers',
    {
      schema: {
        tags: ['analyzers'],
        summary: 'List analyzers and their current status',
        response: {
          200: AnalyzersListResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = getAnalyzerEngine();
        if (!engine) {
          return reply.send({ enabled: false, analyzers: [] });
        }

        const status = engine.getStatus();
        return reply.send({ enabled: true, analyzers: status });
      } catch (err) {
        logger.error({ err }, 'Failed to get analyzers');
        return reply.code(500).send({ error: 'Failed to get analyzers' });
      }
    }
  );

  // Get analyzer details
  fastify.get(
    '/api/analyzers/:id',
    {
      schema: {
        tags: ['analyzers'],
        summary: 'Get analyzer details',
        params: Type.Object({
          id: Type.String({ minLength: 1 }),
        }),
        response: {
          200: AnalyzerDetailResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = getAnalyzerEngine();
        if (!engine) {
          return reply.code(404).send({ error: 'Analyzer engine not enabled' });
        }

        const { id } = request.params;
        const analyzer = engine.getAnalyzer(id);
        if (!analyzer) {
          return reply.code(404).send({ error: 'Analyzer not found' });
        }

        const status = engine.getStatus().find((s) => s.id === id);
        return reply.send({ analyzer, status });
      } catch (err) {
        logger.error({ err }, 'Failed to get analyzer');
        return reply.code(500).send({ error: 'Failed to get analyzer' });
      }
    }
  );

  // Get analyzer run history
  fastify.get(
    '/api/analyzers/:id/runs',
    {
      schema: {
        tags: ['analyzers'],
        summary: 'Get analyzer run history',
        params: Type.Object({
          id: Type.String({ minLength: 1 }),
        }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
        }),
        response: {
          200: AnalyzerRunsResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = getAnalyzerEngine();
        if (!engine) {
          return reply.code(404).send({ error: 'Analyzer engine not enabled' });
        }

        const { id } = request.params;
        const { limit = 10 } = request.query;

        const analyzer = engine.getAnalyzer(id);
        if (!analyzer) {
          return reply.code(404).send({ error: 'Analyzer not found' });
        }

        const runs = await engine.getRunHistory(id, limit);
        return reply.send({ runs });
      } catch (err) {
        logger.error({ err }, 'Failed to get analyzer runs');
        return reply.code(500).send({ error: 'Failed to get analyzer runs' });
      }
    }
  );

  // Manually trigger an analyzer run
  fastify.post(
    '/api/analyzers/:id/run',
    {
      schema: {
        tags: ['analyzers'],
        summary: 'Manually trigger an analyzer run',
        params: Type.Object({
          id: Type.String({ minLength: 1 }),
        }),
        response: {
          200: AnalyzerRunTriggerResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = getAnalyzerEngine();
        if (!engine) {
          return reply.code(404).send({ error: 'Analyzer engine not enabled' });
        }

        const { id } = request.params;
        const analyzer = engine.getAnalyzer(id);
        if (!analyzer) {
          return reply.code(404).send({ error: 'Analyzer not found' });
        }

        logger.info({ analyzer: id }, 'Manually triggering analyzer run');
        const result = await engine.triggerRun(id);

        if (!result) {
          return reply.code(500).send({ error: 'Failed to trigger analyzer run' });
        }

        return reply.send({ success: true, result });
      } catch (err) {
        logger.error({ err }, 'Failed to trigger analyzer run');
        return reply.code(500).send({ error: 'Failed to trigger analyzer run' });
      }
    }
  );
};

export default apiRoutes;
