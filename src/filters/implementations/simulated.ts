import type { Filter, FilterContext, FilterResult } from '../types.js';

export class SimulatedFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;

  constructor(name: string, enabled: boolean = true) {
    this.name = name;
    this.enabled = enabled;
  }

  matches(ctx: FilterContext): FilterResult {
    const isSimulated = ctx.alert.simulated === true;

    return {
      matched: isSimulated,
      filterName: this.name,
      reason: isSimulated ? 'Alert is simulated' : undefined,
    };
  }
}
