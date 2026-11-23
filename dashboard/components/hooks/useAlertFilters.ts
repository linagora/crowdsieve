'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import type { StoredAlert } from '@/lib/types';
import { fetchAlerts } from '@/lib/api';
import {
  DEFAULT_FILTERS,
  alertMatchesFilters,
  filtersToAlertQuery,
  hasActiveFilters as filtersAreActive,
  parseFilterParams,
  writeFilterParams,
  type FilterState,
} from '@/lib/alertFilters';
import { LOAD_MORE_PAGE_SIZE, appendAlertPage, mergeRefreshedAlerts } from '@/lib/alertPaging';

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

function fetchErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return 'Request timed out. Please try again.';
    }
    // fetch() rejects with a TypeError when the request cannot be sent
    if (err instanceof TypeError) {
      return 'Network error. Please check your connection.';
    }
  }
  return fallback;
}

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
  // Whether the last page fetched was full, i.e. "Load more alerts" may
  // find older alerts
  const [hasMore, setHasMore] = useState(initialAlerts.length >= limit);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Incremented whenever the list is replaced (new filters, or a refresh
  // that could not keep the loaded pages): responses of requests started
  // before are stale and dropped
  const generationRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

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

  // Filters as a value that only changes when one of them does, so that
  // re-applying the same filters does not trigger a new fetch
  const { since, until, range, scenario, machineId, status, ip, country } = filters;
  const appliedFilters = useMemo<FilterState>(
    () => ({ since, until, range, scenario, machineId, status, ip, country }),
    [since, until, range, scenario, machineId, status, ip, country]
  );

  const replaceList = useCallback(() => {
    generationRef.current += 1;
    isLoadingMoreRef.current = false;
    setIsLoadingMore(false);
    setLoadMoreError(null);
    return generationRef.current;
  }, []);

  // Reusable fetch function
  const doFetch = useCallback(
    async (isAutoRefresh = false) => {
      // Every filter is applied by the API
      const hasServerFilters = filtersAreActive(appliedFilters);

      if (!hasServerFilters && !isAutoRefresh) {
        replaceList();
        setAlerts(initialAlertsRef.current);
        setHasMore(initialAlertsRef.current.length >= limit);
        return;
      }

      const generation = isAutoRefresh ? generationRef.current : replaceList();

      // Don't show loading spinner for auto-refresh
      if (!isAutoRefresh) {
        setIsLoading(true);
      }
      setError(null);

      try {
        // For auto-refresh without filters, use newerThan optimization
        // This returns [] if no new alerts, or the most recent page if there are new ones
        // Use alertsRef to avoid dependency on alerts state (would cause infinite loop)
        const latestTimestamp =
          isAutoRefresh && !hasServerFilters ? getLatestTimestamp(alertsRef.current) : null;

        const result = await fetchAlerts({
          limit,
          ...filtersToAlertQuery(appliedFilters),
          newerThan: latestTimestamp || undefined,
        });

        // Filters changed (or the list was reset) while this request ran
        if (generation !== generationRef.current) return;

        // If using newerThan optimization and result is empty, nothing new - skip state update
        if (latestTimestamp && result.length === 0) {
          setLastUpdated(new Date());
          return;
        }

        if (isAutoRefresh) {
          // Add the new alerts at the top and keep the pages loaded with
          // "Load more", unless they can no longer be stitched together
          const merged = mergeRefreshedAlerts(alertsRef.current, result);
          if (merged.reset) {
            replaceList();
            setHasMore(result.length >= limit);
          }
          setAlerts(merged.alerts);
        } else {
          setAlerts(result);
          setHasMore(result.length >= limit);
        }
        setLastUpdated(new Date());
      } catch (err) {
        // Don't show errors for auto-refresh failures
        if (!isAutoRefresh && generation === generationRef.current) {
          setError(fetchErrorMessage(err, 'Failed to fetch filtered alerts'));
          console.error('Filter fetch error:', err);
        }
      } finally {
        if (!isAutoRefresh && generation === generationRef.current) {
          setIsLoading(false);
        }
      }
    },
    [
      appliedFilters,
      limit,
      replaceList,
      // Note: alerts is intentionally NOT in dependencies - we use alertsRef
      // to avoid infinite loop: doFetch changes -> useEffect runs -> setAlerts -> doFetch changes
    ]
  );

  // Fetch the next page of the current list ("Load more alerts")
  const loadMore = useCallback(async () => {
    if (isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    const generation = generationRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchAlerts({
        ...filtersToAlertQuery(appliedFilters),
        limit: LOAD_MORE_PAGE_SIZE,
        offset: alertsRef.current.length,
      });
      if (generation !== generationRef.current) return;
      setAlerts((prev) => appendAlertPage(prev, page));
      setHasMore(page.length >= LOAD_MORE_PAGE_SIZE);
    } catch (err) {
      if (generation === generationRef.current) {
        setLoadMoreError(fetchErrorMessage(err, 'Failed to load more alerts'));
        console.error('Load more error:', err);
      }
    } finally {
      if (generation === generationRef.current) {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [appliedFilters]);

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

  const hasActiveFilters = filtersAreActive(filters);

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
    hasMore,
    isLoadingMore,
    loadMoreError,
    loadMore,
  };
}
