'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { StoredAlert } from '@/lib/types';
import { fetchAlerts } from '@/lib/api';

export interface FilterState {
  since: Date | null;
  until: Date | null;
  scenario: string | null;
  machineId: string | null;
  status: 'all' | 'filtered' | 'forwarded';
}

interface UseAlertFiltersOptions {
  initialAlerts: StoredAlert[];
  limit?: number;
  statsTimeBounds?: { min: string | null; max: string | null };
  autoRefreshInterval?: number; // in milliseconds, 0 to disable
}

const DEFAULT_AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

export function useAlertFilters({
  initialAlerts,
  limit = 100,
  statsTimeBounds,
  autoRefreshInterval = DEFAULT_AUTO_REFRESH_INTERVAL,
}: UseAlertFiltersOptions) {
  const [filters, setFilters] = useState<FilterState>({
    since: null,
    until: null,
    scenario: null,
    machineId: null,
    status: 'all',
  });
  const [alerts, setAlerts] = useState<StoredAlert[]>(initialAlerts);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  // Keep a stable reference to initialAlerts to avoid unnecessary re-fetches
  const initialAlertsRef = useRef(initialAlerts);
  initialAlertsRef.current = initialAlerts;

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
  const doFetch = useCallback(async (isAutoRefresh = false) => {
    // Only fetch from server if time, scenario or machineId filters are set
    const hasServerFilters =
      filters.since || filters.until || filters.scenario || filters.machineId;

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
      const result = await fetchAlerts({
        limit,
        since: filters.since?.toISOString(),
        until: filters.until?.toISOString(),
        scenario: filters.scenario || undefined,
        machineId: filters.machineId || undefined,
      });
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
  }, [filters.since, filters.until, filters.scenario, filters.machineId, limit]);

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

  // Apply client-side status filter
  const filteredAlerts = alerts.filter((alert) => {
    if (filters.status === 'filtered') return alert.filtered;
    if (filters.status === 'forwarded') return !alert.filtered;
    return true;
  });

  const updateFilters = useCallback((updates: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({
      since: null,
      until: null,
      scenario: null,
      machineId: null,
      status: 'all',
    });
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
  };
}
