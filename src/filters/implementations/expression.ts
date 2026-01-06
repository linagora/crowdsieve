import IPCIDR from 'ip-cidr';
import { minimatch } from 'minimatch';
import type { Filter, FilterContext, FilterResult } from '../types.js';
import type { ExpressionConditionType } from '../../config/index.js';

// Maximum regex pattern length to prevent ReDoS
const MAX_REGEX_LENGTH = 500;

type FieldValue = unknown;

export class ExpressionFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;
  private condition: ExpressionConditionType;

  constructor(name: string, enabled: boolean, condition: ExpressionConditionType) {
    this.name = name;
    this.enabled = enabled;
    this.condition = condition;
  }

  matches(ctx: FilterContext): FilterResult {
    const result = this.evaluate(this.condition, ctx.alert as unknown as Record<string, unknown>);
    return {
      matched: result.matched,
      filterName: this.name,
      reason: result.reason,
    };
  }

  private evaluate(
    condition: ExpressionConditionType,
    data: Record<string, unknown>
  ): { matched: boolean; reason?: string } {
    // Logical operators with short-circuit evaluation
    if ('conditions' in condition) {
      if (condition.op === 'and') {
        const reasons: string[] = [];
        for (const c of condition.conditions) {
          const result = this.evaluate(c, data);
          if (!result.matched) {
            return { matched: false };
          }
          if (result.reason) {
            reasons.push(result.reason);
          }
        }
        return {
          matched: true,
          reason: reasons.join(' AND '),
        };
      }
      if (condition.op === 'or') {
        for (const c of condition.conditions) {
          const result = this.evaluate(c, data);
          if (result.matched) {
            return {
              matched: true,
              reason: result.reason,
            };
          }
        }
        return { matched: false };
      }
    }

    if ('condition' in condition && condition.op === 'not') {
      const result = this.evaluate(condition.condition, data);
      return {
        matched: !result.matched,
        reason: !result.matched ? `NOT(${result.reason || 'condition'})` : undefined,
      };
    }

    // Field condition
    if ('field' in condition) {
      return this.evaluateFieldCondition(condition, data);
    }

    return { matched: false };
  }

  private evaluateFieldCondition(
    condition: { field: string; op: string; value?: unknown },
    data: Record<string, unknown>
  ): { matched: boolean; reason?: string } {
    const fieldValue = this.getFieldValue(data, condition.field);
    const { op, value } = condition;

    let matched = false;
    let reason: string | undefined;

    switch (op) {
      case 'eq':
        matched = fieldValue === value;
        reason = matched ? `${condition.field} equals ${JSON.stringify(value)}` : undefined;
        break;

      case 'ne':
        matched = fieldValue !== value;
        reason = matched ? `${condition.field} not equals ${JSON.stringify(value)}` : undefined;
        break;

      case 'gt':
        matched = typeof fieldValue === 'number' && typeof value === 'number' && fieldValue > value;
        reason = matched ? `${condition.field} > ${value}` : undefined;
        break;

      case 'gte':
        matched = typeof fieldValue === 'number' && typeof value === 'number' && fieldValue >= value;
        reason = matched ? `${condition.field} >= ${value}` : undefined;
        break;

      case 'lt':
        matched = typeof fieldValue === 'number' && typeof value === 'number' && fieldValue < value;
        reason = matched ? `${condition.field} < ${value}` : undefined;
        break;

      case 'lte':
        matched = typeof fieldValue === 'number' && typeof value === 'number' && fieldValue <= value;
        reason = matched ? `${condition.field} <= ${value}` : undefined;
        break;

      case 'in':
        if (Array.isArray(value)) {
          matched = value.includes(fieldValue as string | number | boolean);
          reason = matched ? `${condition.field} in [${value.join(', ')}]` : undefined;
        }
        break;

      case 'not_in':
        if (Array.isArray(value)) {
          matched = !value.includes(fieldValue as string | number | boolean);
          reason = matched ? `${condition.field} not in [${value.join(', ')}]` : undefined;
        }
        break;

      case 'contains':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          matched = fieldValue.includes(value);
          reason = matched ? `${condition.field} contains "${value}"` : undefined;
        } else if (Array.isArray(fieldValue)) {
          matched = fieldValue.includes(value);
          reason = matched ? `${condition.field} contains ${JSON.stringify(value)}` : undefined;
        }
        break;

      case 'not_contains':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          matched = !fieldValue.includes(value);
          reason = matched ? `${condition.field} not contains "${value}"` : undefined;
        } else if (Array.isArray(fieldValue)) {
          matched = !fieldValue.includes(value);
          reason = matched ? `${condition.field} not contains ${JSON.stringify(value)}` : undefined;
        }
        break;

      case 'starts_with':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          matched = fieldValue.startsWith(value);
          reason = matched ? `${condition.field} starts with "${value}"` : undefined;
        }
        break;

      case 'ends_with':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          matched = fieldValue.endsWith(value);
          reason = matched ? `${condition.field} ends with "${value}"` : undefined;
        }
        break;

      case 'empty':
        matched = this.isEmpty(fieldValue);
        reason = matched ? `${condition.field} is empty` : undefined;
        break;

      case 'not_empty':
        matched = !this.isEmpty(fieldValue);
        reason = matched ? `${condition.field} is not empty` : undefined;
        break;

      case 'glob':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          matched = minimatch(fieldValue, value);
          reason = matched ? `${condition.field} matches glob "${value}"` : undefined;
        } else if (typeof fieldValue === 'string' && Array.isArray(value)) {
          const matchingPattern = value.find((p) => typeof p === 'string' && minimatch(fieldValue, p));
          matched = matchingPattern !== undefined;
          reason = matched ? `${condition.field} matches glob "${matchingPattern}"` : undefined;
        }
        break;

      case 'regex':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          const regex = this.compileRegex(value);
          if (regex) {
            matched = regex.test(fieldValue);
            reason = matched ? `${condition.field} matches regex "${value}"` : undefined;
          }
        } else if (typeof fieldValue === 'string' && Array.isArray(value)) {
          for (const pattern of value) {
            if (typeof pattern === 'string') {
              const regex = this.compileRegex(pattern);
              if (regex && regex.test(fieldValue)) {
                matched = true;
                reason = `${condition.field} matches regex "${pattern}"`;
                break;
              }
            }
          }
        }
        break;

      case 'cidr':
        if (typeof fieldValue === 'string') {
          if (typeof value === 'string') {
            matched = this.isInCIDR(fieldValue, value);
            reason = matched ? `${condition.field} in CIDR ${value}` : undefined;
          } else if (Array.isArray(value)) {
            for (const cidr of value) {
              if (typeof cidr === 'string' && this.isInCIDR(fieldValue, cidr)) {
                matched = true;
                reason = `${condition.field} in CIDR ${cidr}`;
                break;
              }
            }
          }
        }
        break;
    }

    return { matched, reason };
  }

  /**
   * Get a nested field value using dot notation.
   * Note: Does not support escaped dots in field names or array index notation (e.g., 'events[0]').
   * Use simple dot paths like 'source.ip' or 'source.cn'.
   */
  private getFieldValue(data: Record<string, unknown>, path: string): FieldValue {
    const parts = path.split('.');
    let current: unknown = data;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    if (typeof value === 'string') {
      return value.length === 0;
    }
    return false;
  }

  private compileRegex(pattern: string): RegExp | null {
    try {
      if (pattern.length > MAX_REGEX_LENGTH) {
        return null;
      }
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }

  private isInCIDR(ip: string, cidr: string): boolean {
    try {
      const cidrObj = new IPCIDR(cidr);
      return cidrObj.contains(ip);
    } catch {
      return false;
    }
  }
}
