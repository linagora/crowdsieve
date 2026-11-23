'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationsStatus } from '@/lib/notifications';

/**
 * Poll /api/notifications, like useStatus: plain fetch (a 401 does not show
 * the session-expired overlay), polling stops on 401/403. `refresh` reloads
 * right away (e.g. after "Send test").
 */
export function useNotifications(intervalMs: number): {
  notifications: NotificationsStatus | null;
  error: boolean;
  refresh: () => void;
} {
  const [notifications, setNotifications] = useState<NotificationsStatus | null>(null);
  const [error, setError] = useState(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch('/api/notifications', {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setNotifications(null);
          return; // stop polling
        }
        if (res.ok) {
          setNotifications((await res.json()) as NotificationsStatus);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
      // A single pending timer, even when refresh() overlaps a poll.
      if (!cancelled) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(poll, intervalMs);
      }
    }

    pollRef.current = () => void poll();
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  const refresh = useCallback(() => pollRef.current(), []);
  return { notifications, error, refresh };
}
