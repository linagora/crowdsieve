import { describe, expect, it } from 'vitest';
import { formatUtcDateTime } from '../dashboard/lib/dateTime.js';

describe('formatUtcDateTime', () => {
  it('should render an ISO string in a stable UTC form', () => {
    expect(formatUtcDateTime('2026-11-11T12:14:19Z')).toBe('2026-11-11 12:14:19 UTC');
  });

  it('should drop milliseconds so the value is stable', () => {
    expect(formatUtcDateTime('2026-11-11T12:24:20.330Z')).toBe('2026-11-11 12:24:20 UTC');
  });

  it('should accept a Date instance', () => {
    expect(formatUtcDateTime(new Date('2026-11-11T11:15:49Z'))).toBe('2026-11-11 11:15:49 UTC');
  });

  it('should return null for an invalid value', () => {
    expect(formatUtcDateTime('not a date')).toBeNull();
    expect(formatUtcDateTime(new Date('invalid'))).toBeNull();
  });
});
