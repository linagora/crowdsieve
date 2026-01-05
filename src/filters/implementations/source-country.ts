import type { Filter, FilterContext, FilterResult } from '../types.js';

export class SourceCountryFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;
  private countrySet: Set<string>;
  private mode: 'allowlist' | 'blocklist';

  constructor(
    name: string,
    enabled: boolean,
    countries: string[],
    mode: 'allowlist' | 'blocklist'
  ) {
    this.name = name;
    this.enabled = enabled;
    this.countrySet = new Set(countries.map((c) => c.toUpperCase()));
    this.mode = mode;
  }

  matches(ctx: FilterContext): FilterResult {
    const country = ctx.alert.source.cn?.toUpperCase();

    if (!country) {
      // No country info - match in allowlist mode (not in allowlist)
      if (this.mode === 'allowlist') {
        return {
          matched: true,
          filterName: this.name,
          reason: 'No country info, not in allowlist',
        };
      }
      return {
        matched: false,
        filterName: this.name,
      };
    }

    const inList = this.countrySet.has(country);

    if (this.mode === 'blocklist') {
      return {
        matched: inList,
        filterName: this.name,
        reason: inList ? `Country "${country}" is in blocklist` : undefined,
      };
    } else {
      return {
        matched: !inList,
        filterName: this.name,
        reason: !inList ? `Country "${country}" is not in allowlist` : undefined,
      };
    }
  }
}
