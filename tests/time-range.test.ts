import { describe, expect, it } from 'vitest';
import { endOfDay, startOfDay } from 'date-fns';
import {
  EMPTY_DAY_RANGE,
  draftFromFilter,
  draftToRange,
  resolveDayRange,
} from '../dashboard/lib/timeRange.js';

describe('resolveDayRange', () => {
  it('should return an empty draft when the range is cleared', () => {
    expect(resolveDayRange(undefined)).toEqual({ draft: EMPTY_DAY_RANGE, applied: null });
  });

  it('should keep a same-day selection as an in-progress draft', () => {
    // react-day-picker 9 returns { from: day, to: day } on the first click
    const day = new Date(2026, 10, 11, 0, 0, 0, 0);
    const { draft, applied } = resolveDayRange({ from: day, to: day });

    expect(applied).toBeNull();
    expect(draft).toEqual({ from: startOfDay(day), to: null });
  });

  it('should apply a range once two distinct days are selected', () => {
    const from = new Date(2026, 9, 1, 0, 0, 0, 0);
    const to = new Date(2026, 9, 5, 0, 0, 0, 0);
    const { draft, applied } = resolveDayRange({ from, to });

    expect(draft).toEqual({ from: startOfDay(from), to: startOfDay(to) });
    expect(applied).not.toBeNull();
    expect(applied?.since).toEqual(startOfDay(from));
    // The whole last day must be included, not just its midnight
    expect(applied?.until).toEqual(endOfDay(to));
    expect(applied?.until.getHours()).toBe(23);
    expect(applied?.until.getMinutes()).toBe(59);
  });

  it('should apply a range selected backwards', () => {
    const earlier = new Date(2026, 9, 1, 0, 0, 0, 0);
    const later = new Date(2026, 9, 5, 0, 0, 0, 0);
    // DayPicker orders the range itself, but stay tolerant to reversed input
    const { applied } = resolveDayRange({ from: earlier, to: later });

    expect(applied?.since).toEqual(startOfDay(earlier));
    expect(applied?.until).toEqual(endOfDay(later));
  });
});

describe('draftToRange', () => {
  it('should apply a single-day selection as a whole day', () => {
    const day = new Date(2026, 10, 11, 0, 0, 0, 0);
    const applied = draftToRange({ from: day, to: null });

    expect(applied).toEqual({ since: startOfDay(day), until: endOfDay(day) });
  });

  it('should apply a multi-day draft', () => {
    const from = new Date(2026, 9, 1, 0, 0, 0, 0);
    const to = new Date(2026, 9, 5, 0, 0, 0, 0);

    expect(draftToRange({ from, to })).toEqual({
      since: startOfDay(from),
      until: endOfDay(to),
    });
  });

  it('should not apply an empty draft', () => {
    expect(draftToRange(EMPTY_DAY_RANGE)).toBeNull();
  });
});

describe('draftFromFilter', () => {
  it('should return an empty draft when no filter is applied', () => {
    expect(draftFromFilter(null, null)).toEqual(EMPTY_DAY_RANGE);
  });

  it('should map an applied range back to whole days', () => {
    const since = new Date(2026, 9, 1, 0, 0, 0, 0);
    const until = new Date(2026, 9, 5, 23, 59, 59, 999);

    expect(draftFromFilter(since, until)).toEqual({
      from: startOfDay(since),
      to: startOfDay(until),
    });
  });

  it('should keep an open-ended range open-ended', () => {
    const since = new Date(2026, 10, 10, 12, 33, 41, 441);

    expect(draftFromFilter(since, null)).toEqual({
      from: startOfDay(since),
      to: null,
    });
  });
});
