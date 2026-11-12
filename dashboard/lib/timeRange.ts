import { endOfDay, isSameDay, startOfDay } from 'date-fns';

export interface DayRangeDraft {
  from: Date | null;
  to: Date | null;
}

export interface DayRange {
  since: Date;
  until: Date;
}

export const EMPTY_DAY_RANGE: DayRangeDraft = { from: null, to: null };

/**
 * Build the calendar draft from the currently applied filter values.
 * Only whole days are represented: an applied range ending at the end of a
 * day is shown on that day in the calendar.
 */
export function draftFromFilter(since: Date | null, until: Date | null): DayRangeDraft {
  if (!since && !until) return EMPTY_DAY_RANGE;
  return {
    from: since ? startOfDay(since) : null,
    to: until ? startOfDay(until) : null,
  };
}

/**
 * Interpret a react-day-picker range selection.
 *
 * react-day-picker 9 returns `{ from: day, to: day }` on the first click of a
 * range, so a same-day range is an in-progress selection rather than a
 * complete one. A complete range is only returned once two distinct days are
 * selected, and its `until` is extended to the end of the last day so that the
 * whole day is included in the filter.
 */
export function resolveDayRange(range: { from?: Date; to?: Date } | undefined): {
  draft: DayRangeDraft;
  applied: DayRange | null;
} {
  if (!range?.from) return { draft: EMPTY_DAY_RANGE, applied: null };

  const from = startOfDay(range.from);
  if (!range.to || isSameDay(range.from, range.to)) {
    return { draft: { from, to: null }, applied: null };
  }

  return {
    draft: { from, to: startOfDay(range.to) },
    applied: { since: from, until: endOfDay(range.to) },
  };
}

/**
 * Apply a draft range, including single-day selections (from = to = that day).
 * Returns null when the draft has no start day.
 */
export function draftToRange(draft: DayRangeDraft): DayRange | null {
  if (!draft.from) return null;
  const to = draft.to ?? draft.from;
  return { since: startOfDay(draft.from), until: endOfDay(to) };
}
