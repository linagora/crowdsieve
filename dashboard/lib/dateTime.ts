/**
 * Deterministic, time zone independent rendering of a date.
 *
 * Used for the markup produced on the server (and on the first client render)
 * so that it matches during hydration. The browser-local rendering is applied
 * after mount by the `LocalDateTime` component.
 */
export function formatUtcDateTime(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
