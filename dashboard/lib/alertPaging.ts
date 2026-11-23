/**
 * Helpers for the "Load more alerts" pagination of the alert lists.
 *
 * Lists are sorted newest first and pages are fetched with
 * `offset = alerts already listed`. Alerts that arrive between two requests
 * shift the offsets, so a page may repeat alerts already shown: they are
 * dropped by id. It can never skip any, since new alerts only push older ones
 * further down.
 */

/** Number of alerts fetched by each "Load more alerts". */
export const LOAD_MORE_PAGE_SIZE = 100;

/** Append a page fetched with `offset = current.length`, without duplicates. */
export function appendAlertPage<T extends { id: number }>(current: T[], page: T[]): T[] {
  const known = new Set(current.map((a) => a.id));
  const added = page.filter((a) => !known.has(a.id));
  return added.length > 0 ? [...current, ...added] : current;
}

/**
 * Merge the refreshed first page of a list into the list currently shown,
 * keeping the pages loaded with "Load more" below it.
 *
 * When the two do not overlap, more alerts arrived than the first page holds
 * (or the listed ones are gone): the loaded pages cannot be stitched to the
 * new first page without a gap, so the list restarts from the fresh page and
 * `reset` is true.
 */
export function mergeRefreshedAlerts<T extends { id: number }>(
  current: T[],
  fresh: T[]
): { alerts: T[]; reset: boolean } {
  const freshIds = new Set(fresh.map((a) => a.id));
  const overlaps = current.some((a) => freshIds.has(a.id));
  if (!overlaps) {
    return { alerts: fresh, reset: true };
  }
  return { alerts: [...fresh, ...current.filter((a) => !freshIds.has(a.id))], reset: false };
}

/**
 * Result line of an alert list: "Showing 300 alerts — more available" while
 * more pages can be loaded, "Showing 312 alerts" otherwise.
 */
export function alertCountLabel(count: number, hasMore: boolean): string {
  const base = `Showing ${count.toLocaleString('en-US')} alert${count === 1 ? '' : 's'}`;
  return hasMore ? `${base} — more available` : base;
}
