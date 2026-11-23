/**
 * Bulk unban of active decisions: one `DELETE /api/decisions/:id` per
 * decision (the route that records the unban audit row), a few at a time.
 */

export const BULK_UNBAN_CONCURRENCY = 4;

export interface UnbanTarget {
  server: string;
  id: number;
  /** The decision's value (IP or range), sent as `ip` to the delete route. */
  value: string;
}

export interface UnbanResult {
  target: UnbanTarget;
  ok: boolean;
  error?: string;
}

/**
 * Run `task` on every item with at most `limit` tasks in flight. Results keep
 * the order of `items`; a rejected task is reported, never thrown.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export type DeleteDecisionFn = (target: UnbanTarget, reason: string) => Promise<void>;

/**
 * Delete every target with the same reason. `deleteDecision` throws an Error
 * carrying the message to report when a deletion fails.
 */
export async function bulkUnban(
  targets: readonly UnbanTarget[],
  reason: string,
  deleteDecision: DeleteDecisionFn,
  concurrency = BULK_UNBAN_CONCURRENCY,
  onProgress?: (done: number, total: number) => void
): Promise<UnbanResult[]> {
  let done = 0;
  const settled = await runWithConcurrency(targets, concurrency, async (target) => {
    try {
      await deleteDecision(target, reason);
    } finally {
      done++;
      onProgress?.(done, targets.length);
    }
  });
  return settled.map((result, i) =>
    result.status === 'fulfilled'
      ? { target: targets[i], ok: true }
      : {
          target: targets[i],
          ok: false,
          error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
        }
  );
}

const MAX_LISTED_FAILURES = 5;

/**
 * `2 decisions deleted`, or `1 deleted, 2 failed: lapi-qa: Decision not found
 * (×2)`. Identical failures are grouped; at most 5 groups are listed.
 */
export function summarizeUnbanResults(results: readonly UnbanResult[]): string {
  const deleted = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    return `${deleted} decision${deleted === 1 ? '' : 's'} deleted`;
  }
  const groups = new Map<string, number>();
  for (const failure of failures) {
    const label = `${failure.target.server}: ${failure.error || 'Unknown error'}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const listed = Array.from(groups.entries())
    .slice(0, MAX_LISTED_FAILURES)
    .map(([label, count]) => (count > 1 ? `${label} (×${count})` : label));
  const more = groups.size - listed.length;
  const details = listed.join('; ') + (more > 0 ? `; and ${more} more` : '');
  return `${deleted} deleted, ${failures.length} failed: ${details}`;
}

/**
 * Delete one decision through the dashboard API (same request as the single
 * delete of the search results).
 */
export function makeDeleteDecision(
  fetcher: (input: string, init: RequestInit) => Promise<Response>
): DeleteDecisionFn {
  return async (target, reason) => {
    const res = await fetcher(
      `/api/decisions/${encodeURIComponent(String(target.id))}?server=${encodeURIComponent(target.server)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: target.value, reason }),
      }
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error || `Failed to delete decision (HTTP ${res.status})`);
    }
  };
}
