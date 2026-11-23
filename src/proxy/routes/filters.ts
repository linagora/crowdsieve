import { Type } from 'typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { stringify as stringifyYaml } from 'yaml';
import type { Alert } from '../../models/alert.js';
import {
  ErrorResponse,
  FilterRuleStatsResponse,
  FilterRulesResponse,
  FilterTestBody,
  FilterTestResponse,
  IsoDate,
} from './schemas.js';

/**
 * Read-only views of the filter rules: their definitions, the number of
 * stored alerts each one matched, and a dry run of the current rules on a
 * stored alert.
 *
 * Registered by the API routes plugin (api.ts), so its X-API-Key hook applies.
 */
const filterRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const { storage, proxyLogger: logger } = fastify;

  // List the rules as loaded at startup
  fastify.get(
    '/api/filters',
    {
      schema: {
        tags: ['filters'],
        summary: 'List the filter rules and the filter mode',
        response: {
          200: FilterRulesResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = fastify.filterEngine;
        // Only the rule definitions: the file name, not its path.
        const rules = engine.getRules().map((rule) => ({
          name: rule.name,
          description: rule.description ?? null,
          enabled: rule.enabled,
          file: rule.file ?? null,
          condition: stringifyYaml(rule.filter),
        }));
        return reply.send({ mode: engine.getMode(), rules });
      } catch (err) {
        logger.error({ err }, 'Failed to list filter rules');
        return reply.code(500).send({ error: 'Failed to list filter rules' });
      }
    }
  );

  // Stored alerts matched by each rule
  fastify.get(
    '/api/filters/stats',
    {
      schema: {
        tags: ['filters'],
        summary: 'Count the stored alerts matched by each filter rule',
        description:
          'Counts alerts by the rule names saved when they were stored. Local audit rows and ' +
          'alerts stored before rule names were saved count under no rule.',
        querystring: Type.Object({
          since: Type.Optional(IsoDate),
        }),
        response: {
          200: FilterRuleStatsResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      let since: Date | undefined;
      if (request.query.since) {
        since = new Date(request.query.since);
        // Same bounds as the other date filters: not before 2020, not more
        // than one day in the future.
        if (
          isNaN(since.getTime()) ||
          since < new Date('2020-01-01T00:00:00Z') ||
          since.getTime() > Date.now() + 24 * 60 * 60 * 1000
        ) {
          return reply.code(400).send({ error: 'Since date out of acceptable range' });
        }
      }
      try {
        return reply.send(await storage.getFilterRuleStats(since));
      } catch (err) {
        logger.error({ err }, 'Failed to get filter rule stats');
        return reply.code(500).send({ error: 'Failed to get filter rule stats' });
      }
    }
  );

  // Run the current rules on a stored alert, without storing anything
  fastify.post(
    '/api/filters/test',
    {
      schema: {
        tags: ['filters'],
        summary: 'Test the current filter rules on a stored alert',
        description:
          'Runs the loaded rules on the payload stored with the alert and tells whether it ' +
          'would be filtered. Read-only: nothing is stored or forwarded.',
        body: FilterTestBody,
        response: {
          200: FilterTestResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          422: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const stored = await storage.getAlertById(request.body.alertId);
        if (!stored) {
          return reply.code(404).send({ error: 'Alert not found' });
        }
        if (stored.localAudit) {
          return reply.code(422).send({ error: 'This entry is an audit record, not an alert' });
        }

        let alert: unknown = null;
        try {
          alert = stored.rawJson ? JSON.parse(stored.rawJson) : null;
        } catch {
          alert = null;
        }
        if (!alert || typeof alert !== 'object' || Array.isArray(alert)) {
          return reply.code(422).send({ error: 'The alert has no stored payload to test' });
        }

        const detail = fastify.filterEngine.process([alert as Alert]).filterDetails[0];
        return reply.send({
          filtered: detail.filtered,
          matched: detail.matchedFilters.map((f) => ({
            name: f.filterName,
            reason: f.reason ?? null,
          })),
        });
      } catch (err) {
        logger.error({ err }, 'Failed to test filter rules');
        return reply.code(500).send({ error: 'Failed to test filter rules' });
      }
    }
  );
};

export default filterRoutes;
