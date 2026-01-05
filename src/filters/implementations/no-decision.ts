import type { Filter, FilterContext, FilterResult } from '../types.js';

export class NoDecisionFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;

  constructor(name: string, enabled: boolean = true) {
    this.name = name;
    this.enabled = enabled;
  }

  matches(ctx: FilterContext): FilterResult {
    const hasDecisions = ctx.alert.decisions && ctx.alert.decisions.length > 0;

    return {
      matched: !hasDecisions,
      filterName: this.name,
      reason: hasDecisions ? undefined : 'Alert has no decisions',
    };
  }
}
