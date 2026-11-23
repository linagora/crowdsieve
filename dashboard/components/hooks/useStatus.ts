'use client';

import { useEffect, useState } from 'react';
import type { StatusSnapshot } from '@/lib/status';

/**
 * Poll /api/status. Uses plain fetch (not fetchWithAuth) so a 401 or an error
 * never triggers the session-expired overlay: the status is a side widget.
 * `unauthorized` is true once the API answered 401/403, and polling stops.
 */
export function useStatus(intervalMs: number): {
  status: StatusSnapshot | null;
  unauthorized: boolean;
  error: boolean;
} {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch('/api/status', {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setUnauthorized(true);
          setStatus(null);
          return; // stop polling
        }
        if (res.ok) {
          setStatus((await res.json()) as StatusSnapshot);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
      if (!cancelled) timer = setTimeout(poll, intervalMs);
    }

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return { status, unauthorized, error };
}
