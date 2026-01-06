import type { Alert } from '../models/alert.js';
import type { FilterRule } from '../config/index.js';
import type { Filter, FilterContext, FilterResult, FilterEngineResult } from './types.js';
import { NoDecisionFilter } from './implementations/no-decision.js';
import { SimulatedFilter } from './implementations/simulated.js';
import { ScenarioFilter } from './implementations/scenario.js';
import { SourceCountryFilter } from './implementations/source-country.js';
import { SourceIpFilter } from './implementations/source-ip.js';
import { ExpressionFilter } from './implementations/expression.js';

export class FilterEngine {
  private filters: Filter[] = [];
  private mode: 'block' | 'allow';

  constructor(mode: 'block' | 'allow', rules: FilterRule[]) {
    this.mode = mode;
    this.filters = this.buildFilters(rules);
  }

  private buildFilters(rules: FilterRule[]): Filter[] {
    return rules.map((rule) => this.createFilter(rule));
  }

  private createFilter(config: FilterRule): Filter {
    switch (config.type) {
      case 'no-decision':
        return new NoDecisionFilter(config.name, config.enabled);

      case 'simulated':
        return new SimulatedFilter(config.name, config.enabled);

      case 'scenario':
        return new ScenarioFilter(config.name, config.enabled, config.patterns, config.match_mode);

      case 'source-country':
        return new SourceCountryFilter(config.name, config.enabled, config.countries, config.mode);

      case 'source-ip':
        return new SourceIpFilter(config.name, config.enabled, config.cidrs, config.mode);

      case 'expression':
        return new ExpressionFilter(config.name, config.enabled, config.filter);

      default:
        throw new Error(`Unknown filter type: ${(config as FilterRule).type}`);
    }
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
        sourceIp: alert.source.ip || alert.source.value,
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
