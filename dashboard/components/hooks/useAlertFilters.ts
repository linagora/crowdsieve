'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { StoredAlert } from '@/lib/types';
import { fetchAlerts } from '@/lib/api';

export interface FilterState {
  since: Date | null;
  until: Date | null;
  scenario: string | null;
  status: 'all' | 'filtered' | 'forwarded';
}

interface UseAlertFiltersOptions {
  initialAlerts: StoredAlert[];
  limit?: number;
}

export function useAlertFilters({ initialAlerts, limit = 100 }: UseAlertFiltersOptions) {
  const [filters, setFilters] = useState<FilterState>({
    since: null,
    until: null,
    scenario: null,
    status: 'all',
  });
  const [alerts, setAlerts] = useState<StoredAlert[]>(initialAlerts);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a stable reference to initialAlerts to avoid unnecessary re-fetches
  const initialAlertsRef = useRef(initialAlerts);
  initialAlertsRef.current = initialAlerts;

  // Compute time bounds from initial alerts for the slider
  const timeBounds = useMemo(() => {
    if (initialAlerts.length === 0) {
      return { min: new Date(), max: new Date() };
    }
    const times = initialAlerts.map((a) => new Date(a.receivedAt).getTime());
    return {
      min: new Date(Math.min(...times)),
      max: new Date(Math.max(...times)),
    };
  }, [initialAlerts]);

  // Fetch filtered alerts when filters change (except status which is client-side)
  useEffect(() => {
    const fetchFiltered = async () => {
      // Only fetch from server if time or scenario filters are set
      const hasServerFilters = filters.since || filters.until || filters.scenario;

      if (!hasServerFilters) {
        setAlerts(initialAlertsRef.current);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const result = await fetchAlerts({
          limit,
          since: filters.since?.toISOString(),
          until: filters.until?.toISOString(),
          scenario: filters.scenario || undefined,
        });
        setAlerts(result);
      } catch (err) {
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
      } finally {
        setIsLoading(false);
      }
    };

    fetchFiltered();
  }, [filters.since, filters.until, filters.scenario, limit]);

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
      status: 'all',
    });
  }, []);

  const hasActiveFilters =
    filters.since !== null ||
    filters.until !== null ||
    filters.scenario !== null ||
    filters.status !== 'all';

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
  };
}
