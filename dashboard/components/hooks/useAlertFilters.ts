'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import type { StoredAlert } from '@/lib/types';
import { fetchAlerts } from '@/lib/api';
import {
  DEFAULT_FILTERS,
  alertMatchesFilters,
  parseFilterParams,
  writeFilterParams,
  type FilterState,
} from '@/lib/alertFilters';

export type { FilterState } from '@/lib/alertFilters';

interface UseAlertFiltersOptions {
  initialAlerts: StoredAlert[];
  limit?: number;
  statsTimeBounds?: { min: string | null; max: string | null };
  autoRefreshInterval?: number; // in milliseconds, 0 to disable
}

const DEFAULT_AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

// Delay before writing filters into the URL. The time slider fires on every
// move and browsers throttle (Safari even throws on) frequent replaceState calls.
const URL_SYNC_DELAY = 300;

function buildFilterUrl(filters: FilterState): string {
  const params = new URLSearchParams(window.location.search);
  writeFilterParams(params, filters);
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
}

export function useAlertFilters({
  initialAlerts,
  limit = 100,
  statsTimeBounds,
  autoRefreshInterval = DEFAULT_AUTO_REFRESH_INTERVAL,
}: UseAlertFiltersOptions) {
  // Filters are persisted in the query string so that they survive navigation
  // (back button, reload, shared links)
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const [filters, setFilters] = useState<FilterState>(() => parseFilterParams(searchParams));
  // Last query string written by this hook, to tell our own URL updates apart
  // from external navigations (e.g. clicking the "Alerts" menu entry)
  const lastSearchKeyRef = useRef(searchKey);
  const urlSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [alerts, setAlerts] = useState<StoredAlert[]>(initialAlerts);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  // Track the most recent alert timestamp for optimized refresh
  const getLatestTimestamp = (alertList: StoredAlert[]): string | null => {
    if (alertList.length === 0) return null;
    // Alerts are sorted by receivedAt DESC, so first one is most recent
    return alertList[0].receivedAt;
  };

  // Keep a stable reference to initialAlerts to avoid unnecessary re-fetches
  const initialAlertsRef = useRef(initialAlerts);
  initialAlertsRef.current = initialAlerts;

  // Keep a stable reference to alerts for auto-refresh timestamp lookup
  // This prevents doFetch from depending on alerts state, which would cause
  // an infinite loop: doFetch changes -> useEffect runs -> setAlerts -> doFetch changes
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  // Compute time bounds - prefer stats bounds (covers all data) over initial alerts
  const timeBounds = useMemo(() => {
    // Use stats time bounds if available (covers all alerts in database)
    if (statsTimeBounds?.min && statsTimeBounds?.max) {
      return {
        min: new Date(statsTimeBounds.min),
        max: new Date(statsTimeBounds.max),
      };
    }
    // Fallback to initial alerts bounds
    if (initialAlerts.length === 0) {
      return { min: new Date(), max: new Date() };
    }
    const times = initialAlerts.map((a) => new Date(a.receivedAt).getTime());
    return {
      min: new Date(Math.min(...times)),
      max: new Date(Math.max(...times)),
    };
  }, [statsTimeBounds, initialAlerts]);

  // Compute unique machines from initial alerts
  const machines = useMemo(() => {
    const machineMap = new Map<string, number>();
    for (const alert of initialAlerts) {
      if (alert.machineId) {
        machineMap.set(alert.machineId, (machineMap.get(alert.machineId) || 0) + 1);
      }
    }
    return Array.from(machineMap.entries())
      .map(([machineId, count]) => ({ machineId, count }))
      .sort((a, b) => b.count - a.count);
  }, [initialAlerts]);

  // Reusable fetch function
  const doFetch = useCallback(
    async (isAutoRefresh = false) => {
      // Only fetch from server if time, scenario, machineId or status filters are set
      const hasServerFilters =
        filters.since ||
        filters.until ||
        filters.scenario ||
        filters.machineId ||
        filters.status !== 'all';

      if (!hasServerFilters && !isAutoRefresh) {
        setAlerts(initialAlertsRef.current);
        return;
      }

      // Don't show loading spinner for auto-refresh
      if (!isAutoRefresh) {
        setIsLoading(true);
      }
      setError(null);

      try {
        // For auto-refresh without filters, use newerThan optimization
        // This returns [] if no new alerts, or the 100 most recent if there are new ones
        // Use alertsRef to avoid dependency on alerts state (would cause infinite loop)
        const latestTimestamp =
          isAutoRefresh && !hasServerFilters ? getLatestTimestamp(alertsRef.current) : null;

        const result = await fetchAlerts({
          limit,
          since: filters.since?.toISOString(),
          until: filters.until?.toISOString(),
          scenario: filters.scenario || undefined,
          machineId: filters.machineId || undefined,
          filtered: filters.status === 'filtered' ? true : undefined,
          forwardedToCapi: filters.status === 'forwarded' ? true : undefined,
          newerThan: latestTimestamp || undefined,
        });

        // If using newerThan optimization and result is empty, nothing new - skip state update
        if (latestTimestamp && result.length === 0) {
          setLastUpdated(new Date());
          return;
        }

        setAlerts(result);
        setLastUpdated(new Date());
      } catch (err) {
        // Don't show errors for auto-refresh failures
        if (!isAutoRefresh) {
          let errorMessage = 'Failed to fetch filtered alerts';
          if (err instanceof Error) {
            if (err.name === 'AbortError' || err.name === 'TimeoutError') {
              errorMessage = 'Request timed out. Please try again.';
            } else if (err.message.includes('fetch') || err.message.includes('network')) {
              errorMessage = 'Network error. Please check your connection.';
            }
          }
          setError(errorMessage);
          console.error('Filter fetch error:', err);
        }
      } finally {
        if (!isAutoRefresh) {
          setIsLoading(false);
        }
      }
    },
    [
      filters.since,
      filters.until,
      filters.scenario,
      filters.machineId,
      filters.status,
      limit,
      // Note: alerts is intentionally NOT in dependencies - we use alertsRef
      // to avoid infinite loop: doFetch changes -> useEffect runs -> setAlerts -> doFetch changes
    ]
  );

  // Fetch filtered alerts when filters change
  useEffect(() => {
    doFetch(false);
  }, [doFetch]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefreshInterval || autoRefreshInterval <= 0) return;

    const intervalId = setInterval(() => {
      doFetch(true);
    }, autoRefreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefreshInterval, doFetch]);

  // Follow external URL changes
  useEffect(() => {
    if (searchKey === lastSearchKeyRef.current) return;
    lastSearchKeyRef.current = searchKey;
    setFilters(parseFilterParams(new URLSearchParams(searchKey)));
  }, [searchKey]);

  // Write the URL immediately and return it (path + query string)
  const persistFilters = useCallback((): string => {
    if (urlSyncTimerRef.current) {
      clearTimeout(urlSyncTimerRef.current);
      urlSyncTimerRef.current = null;
    }
    const url = buildFilterUrl(filters);
    if (url !== `${window.location.pathname}${window.location.search}`) {
      const qs = url.split('?')[1] ?? '';
      lastSearchKeyRef.current = new URLSearchParams(qs).toString();
      // Native history API: integrated with the Next.js router, without a server round-trip
      window.history.replaceState(null, '', url);
    }
    return url;
  }, [filters]);

  // Sync filters into the URL (debounced)
  useEffect(() => {
    urlSyncTimerRef.current = setTimeout(() => {
      urlSyncTimerRef.current = null;
      persistFilters();
    }, URL_SYNC_DELAY);
    return () => {
      if (urlSyncTimerRef.current) {
        clearTimeout(urlSyncTimerRef.current);
        urlSyncTimerRef.current = null;
      }
    };
  }, [persistFilters]);

  // Apply filters client-side too: the server already did it for fetched
  // alerts, but this hides non-matching alerts from initialAlerts while loading
  const filteredAlerts = alerts.filter((alert) => alertMatchesFilters(alert, filters));

  const updateFilters = useCallback((updates: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const hasActiveFilters =
    filters.since !== null ||
    filters.until !== null ||
    filters.scenario !== null ||
    filters.machineId !== null ||
    filters.status !== 'all';

  const refresh = useCallback(() => {
    doFetch(false);
  }, [doFetch]);

  return {
    filters,
    updateFilters,
    resetFilters,
    alerts: filteredAlerts,
    allAlerts: alerts,
    isLoading,
    error,
    hasActiveFilters,
    timeBounds,
    machines,
    lastUpdated,
    refresh,
    persistFilters,
  };
}
