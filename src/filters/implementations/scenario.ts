import { minimatch } from 'minimatch';
import type { Filter, FilterContext, FilterResult } from '../types.js';

export type MatchMode = 'exact' | 'glob' | 'regex';

export class ScenarioFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;
  private patterns: string[];
  private matchMode: MatchMode;
  private compiledPatterns?: RegExp[];

  constructor(name: string, enabled: boolean, patterns: string[], matchMode: MatchMode = 'glob') {
    this.name = name;
    this.enabled = enabled;
    this.patterns = patterns;
    this.matchMode = matchMode;

    // Pre-compile regex patterns
    if (this.matchMode === 'regex') {
      this.compiledPatterns = patterns.map((p) => new RegExp(p));
    }
  }

  matches(ctx: FilterContext): FilterResult {
    const scenario = ctx.alert.scenario;
    let matched = false;
    let matchedPattern: string | undefined;

    switch (this.matchMode) {
      case 'exact':
        matched = this.patterns.includes(scenario);
        matchedPattern = matched ? scenario : undefined;
        break;

      case 'glob':
        for (const pattern of this.patterns) {
          if (minimatch(scenario, pattern)) {
            matched = true;
            matchedPattern = pattern;
            break;
          }
        }
        break;

      case 'regex':
        for (let i = 0; i < this.compiledPatterns!.length; i++) {
          if (this.compiledPatterns![i].test(scenario)) {
            matched = true;
            matchedPattern = this.patterns[i];
            break;
          }
        }
        break;
    }

    return {
      matched,
      filterName: this.name,
      reason: matched ? `Scenario "${scenario}" matched pattern "${matchedPattern}"` : undefined,
    };
  }
}
