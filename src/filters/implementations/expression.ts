import { Minimatch, minimatch } from 'minimatch';
import { cidrMatches, parseCidr, parseIp, type ParsedCidr } from '../cidr.js';
import type { Filter, FilterContext, FilterResult } from '../types.js';
import type { ExpressionConditionType } from '../../config/index.js';

// Maximum regex pattern length to prevent ReDoS
const MAX_REGEX_LENGTH = 500;

type FieldValue = unknown;

type FieldCondition = { field: string; op: string; value?: unknown };

/** A field path: a single key when it has no dot, else its dot-separated segments. */
type FieldPath = string | readonly string[];

interface RegexEntry {
  /** The pattern as written in the rule, quoted in the match reason. */
  readonly pattern: string;
  readonly regex: RegExp;
}

interface GlobEntry {
  /** The pattern as written in the rule, quoted in the match reason. */
  readonly pattern: string;
  /**
   * null if `new Minimatch(pattern)` threw (for example a pattern over
   * minimatch's length limit), or if the object is too heavy for minimatch's
   * own cache (see {@link compileGlob}). Such a pattern is handed to
   * `minimatch()` at evaluation time, so it throws there, or is compiled again
   * and dropped, as it always did.
   */
  readonly matcher: Minimatch | null;
}

interface CidrEntry {
  /** The range as written in the rule, quoted in the match reason. */
  readonly cidr: string;
  readonly range: ParsedCidr;
}

/**
 * The parts of a field condition that depend only on the rule, prepared once
 * instead of on every alert. Only the list for the condition's own operator is
 * filled; the lists keep the order of the rule's values, so the first match
 * (and so the reason) stays the same.
 */
interface CompiledField {
  /** null if `field` is not a string: it is then split at evaluation, as before. */
  readonly path: FieldPath | null;
  /** Usable regexes; too long or invalid patterns never match and are left out. */
  readonly regexes: readonly RegexEntry[];
  readonly globs: readonly GlobEntry[];
  /** Valid ranges; invalid ones are reported once, when compiled, and left out. */
  readonly ranges: readonly CidrEntry[];
}

export class ExpressionFilter implements Filter {
  readonly name: string;
  readonly enabled: boolean;
  private condition: ExpressionConditionType;
  // Keyed by the field condition objects of `condition`. Rules are loaded once
  // and never change, so the compiled form stays valid for the filter's life.
  private readonly compiled = new WeakMap<object, CompiledField>();

  constructor(name: string, enabled: boolean, condition: ExpressionConditionType) {
    this.name = name;
    this.enabled = enabled;
    this.condition = condition;
    this.precompile(condition, new WeakSet());
  }

  /**
   * Compile every field condition of the tree up front, so that the per-alert
   * path only does lookups and an invalid CIDR range is reported at startup.
   *
   * The walk does not decide anything: evaluate() still does all the
   * dispatching, exactly as before, and a field condition the walk did not
   * reach (a malformed tree) is compiled on first use instead. Compiling a
   * field condition does not throw; the recursion could only overflow the
   * stack on a tree thousands of levels deep, which the YAML loader already
   * refuses.
   */
  private precompile(node: unknown, seen: WeakSet<object>): void {
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.conditions)) {
      for (const child of c.conditions) {
        this.precompile(child, seen);
      }
    }
    if ('condition' in c) {
      this.precompile(c.condition, seen);
    }
    if ('field' in c) {
      this.compiled.set(c, this.compileField(c));
    }
  }

  private compileField(condition: Record<string, unknown>): CompiledField {
    const { field, op, value } = condition;
    const path: FieldPath | null =
      typeof field !== 'string' ? null : field.includes('.') ? field.split('.') : field;

    // A string value is a list of one; in an array, non-strings are skipped.
    const patterns =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((p): p is string => typeof p === 'string')
          : [];

    const regexes: RegexEntry[] = [];
    const globs: GlobEntry[] = [];
    const ranges: CidrEntry[] = [];

    switch (op) {
      case 'regex':
        for (const pattern of patterns) {
          const regex = compileRegex(pattern);
          if (regex) {
            regexes.push({ pattern, regex });
          }
        }
        break;

      case 'glob':
        for (const pattern of patterns) {
          globs.push({ pattern, matcher: compileGlob(pattern) });
        }
        break;

      case 'cidr':
        for (const cidr of patterns) {
          try {
            ranges.push({ cidr, range: parseCidr(cidr) });
          } catch (error) {
            console.warn(
              `ExpressionFilter "${this.name}": failed to parse CIDR "${cidr}", ignoring this range. ` +
                `Check filter configuration. Error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;
    }

    return { path, regexes, globs, ranges };
  }

  private getCompiled(condition: FieldCondition): CompiledField {
    let compiled = this.compiled.get(condition);
    if (compiled === undefined) {
      compiled = this.compileField(condition);
      this.compiled.set(condition, compiled);
    }
    return compiled;
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
    condition: FieldCondition,
    data: Record<string, unknown>
  ): { matched: boolean; reason?: string } {
    const compiled = this.getCompiled(condition);
    // A non-string field is split here so it fails as it always did.
    const fieldValue = getFieldValue(data, compiled.path ?? condition.field.split('.'));
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
        matched =
          typeof fieldValue === 'number' && typeof value === 'number' && fieldValue >= value;
        reason = matched ? `${condition.field} >= ${value}` : undefined;
        break;

      case 'lt':
        matched = typeof fieldValue === 'number' && typeof value === 'number' && fieldValue < value;
        reason = matched ? `${condition.field} < ${value}` : undefined;
        break;

      case 'lte':
        matched =
          typeof fieldValue === 'number' && typeof value === 'number' && fieldValue <= value;
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
        if (typeof fieldValue === 'string') {
          for (const { pattern, matcher } of compiled.globs) {
            if (matcher ? matcher.match(fieldValue) : minimatch(fieldValue, pattern)) {
              matched = true;
              reason = `${condition.field} matches glob "${pattern}"`;
              break;
            }
          }
        }
        break;

      case 'regex':
        if (typeof fieldValue === 'string') {
          for (const { pattern, regex } of compiled.regexes) {
            // No g/y flag (see compileRegex), so test() keeps no state between calls.
            if (regex.test(fieldValue)) {
              matched = true;
              reason = `${condition.field} matches regex "${pattern}"`;
              break;
            }
          }
        }
        break;

      case 'cidr':
        if (typeof fieldValue === 'string' && compiled.ranges.length > 0) {
          // Parsed once for all the ranges. A value that is not an IP matches
          // none of them: that is bad alert data, not a configuration error.
          const ip = parseIp(fieldValue);
          if (ip !== null) {
            for (const { cidr, range } of compiled.ranges) {
              if (cidrMatches(range, ip)) {
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
}

/**
 * Get a nested field value from a pre-split path (see {@link FieldPath}).
 * A null or non-object value along the path gives undefined.
 * Note: Does not support escaped dots in field names or array index notation (e.g., 'events[0]').
 * Use simple dot paths like 'source.ip' or 'source.cn'.
 */
function getFieldValue(data: unknown, path: FieldPath): FieldValue {
  if (typeof path === 'string') {
    return data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)[path]
      : undefined;
  }

  let current: unknown = data;
  for (let i = 0; i < path.length; i++) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[path[i]];
    } else {
      return undefined;
    }
  }

  return current;
}

function compileRegex(pattern: string): RegExp | null {
  try {
    if (pattern.length > MAX_REGEX_LENGTH) {
      return null;
    }
    // No flags: a shared RegExp without g/y has no lastIndex state, so one
    // object can serve every alert.
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

// minimatch() never caches a Minimatch whose weight is over this, so that
// patterns with large brace expansions are not kept on the heap. Copied from
// cacheMaxEntryWeight in minimatch 11.0.9 (dist/esm/index.js, used by
// cachedMinimatch), which does not export it.
const GLOB_MAX_KEPT_WEIGHT = 1 << 12;

/**
 * The weight minimatch gives a compiled object before caching it: the pattern
 * and its expanded patterns. Same as cacheWeight() in minimatch 11.0.9
 * (dist/esm/index.js), which does not export it.
 */
function globWeight(mm: Minimatch): number {
  let w = mm.pattern.length;
  for (const s of mm.globSet) {
    w += s.length + 1;
    if (w > GLOB_MAX_KEPT_WEIGHT) {
      break;
    }
  }
  return w;
}

/**
 * Build the matcher for a glob pattern. `new Minimatch(pattern).match(s)` is
 * what `minimatch(s, pattern)` does with the default options (comment and
 * empty patterns included); it only adds a cache lookup in front. If the
 * constructor throws, return null so the pattern goes through `minimatch()`
 * at evaluation time and throws there, as before, rather than at startup.
 * Also return null for an object minimatch would not cache itself (a large
 * brace expansion can weigh tens of MB): `minimatch()` then compiles it on
 * each call, as before, instead of the filter keeping it for its whole life.
 */
function compileGlob(pattern: string): Minimatch | null {
  let mm: Minimatch;
  try {
    mm = new Minimatch(pattern);
  } catch {
    return null;
  }
  return globWeight(mm) > GLOB_MAX_KEPT_WEIGHT ? null : mm;
}
