import type { Alert } from '../models/alert.js';
import type { FilterRule } from '../config/index.js';
import type { Filter, FilterContext, FilterResult, FilterEngineResult } from './types.js';
import { ExpressionFilter } from './implementations/expression.js';

/**
 * Extract the source IP from an alert.
 *
 * The signals schema accepts any object, so `source` may be missing or hold a
 * non-object value. Only a string is usable as an IP; anything else is
 * reported as undefined.
 */
function extractSourceIp(alert: Alert): string | undefined {
  const source = alert.source as unknown;
  if (!source || typeof source !== 'object') return undefined;
  const { ip, value } = source as { ip?: unknown; value?: unknown };
  const candidate = ip || value;
  return typeof candidate === 'string' ? candidate : undefined;
}

export class FilterEngine {
  private filters: Filter[] = [];
  private mode: 'block' | 'allow';

  constructor(mode: 'block' | 'allow', rules: FilterRule[]) {
    this.mode = mode;
    this.filters = rules.map((rule) => new ExpressionFilter(rule.name, rule.enabled, rule.filter));
  }

  /**
   * Process a batch of alerts through all filters
   * Returns alerts that should be forwarded to CAPI
   */
  process(alerts: Alert[]): FilterEngineResult {
    const result: FilterEngineResult = {
      originalCount: alerts.length,
      filteredCount: 0,
      passedCount: 0,
      alerts: [],
      filterDetails: [],
    };

    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      const ctx: FilterContext = {
        alert,
        machineId: alert.machine_id,
        timestamp: new Date(),
      };

      const matchedFilters: FilterResult[] = [];
      let anyMatch = false;

      for (const filter of this.filters) {
        if (!filter.enabled) continue;

        try {
          const filterResult = filter.matches(ctx);
          if (filterResult.matched) {
            matchedFilters.push(filterResult);
            anyMatch = true;
          }
        } catch {
          // Skip filter on error, don't crash the process
        }
      }

      // In "block" mode: matching = filtered out
      // In "allow" mode: matching = allowed through
      const shouldFilter = this.mode === 'block' ? anyMatch : !anyMatch;

      result.filterDetails.push({
        alertIndex: i,
        scenario: alert.scenario,
        sourceIp: extractSourceIp(alert),
        filtered: shouldFilter,
        matchedFilters,
      });

      if (shouldFilter) {
        result.filteredCount++;
      } else {
        result.passedCount++;
        result.alerts.push(alert);
      }
    }

    return result;
  }

  getFilters(): Filter[] {
    return this.filters;
  }
}

export * from './types.js';
