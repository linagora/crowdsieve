import IPCIDR from 'ip-cidr';
import type { Filter, FilterContext, FilterResult } from '../types.js';

export class SourceIpFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;
  private cidrs: string[];
  private mode: 'allowlist' | 'blocklist';

  constructor(name: string, enabled: boolean, cidrs: string[], mode: 'allowlist' | 'blocklist') {
    this.name = name;
    this.enabled = enabled;
    this.cidrs = cidrs;
    this.mode = mode;
  }

  private isInCIDR(ip: string, cidr: string): boolean {
    try {
      const cidrObj = new IPCIDR(cidr);
      return cidrObj.contains(ip);
    } catch {
      return false;
    }
  }

  matches(ctx: FilterContext): FilterResult {
    const ip = ctx.alert.source.ip || ctx.alert.source.value;

    if (!ip) {
      if (this.mode === 'allowlist') {
        return {
          matched: true,
          filterName: this.name,
          reason: 'No IP found, not in allowlist',
        };
      }
      return {
        matched: false,
        filterName: this.name,
      };
    }

    let matchedCidr: string | undefined;
    for (const cidr of this.cidrs) {
      if (this.isInCIDR(ip, cidr)) {
        matchedCidr = cidr;
        break;
      }
    }

    const inList = matchedCidr !== undefined;

    if (this.mode === 'blocklist') {
      return {
        matched: inList,
        filterName: this.name,
        reason: inList ? `IP "${ip}" matches CIDR "${matchedCidr}"` : undefined,
      };
    } else {
      return {
        matched: !inList,
        filterName: this.name,
        reason: !inList ? `IP "${ip}" not in allowlist` : undefined,
      };
    }
  }
}
