'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { FilterBar } from '@/components/filters/FilterBar';
import { useAlertFilters } from '@/components/hooks/useAlertFilters';
import { AlertCard } from '@/components/AlertCard';
import { LoadMoreAlerts } from '@/components/LoadMoreAlerts';
import { alertDetailHref } from '@/lib/alertFilters';
import { alertCountLabel } from '@/lib/alertPaging';
import { WorldMapWrapper } from '@/components/WorldMapWrapper';
import { Button } from '@/components/ui/button';
import type { StoredAlert, AlertStats } from '@/lib/types';

interface DashboardContentProps {
  initialAlerts: StoredAlert[];
  stats: AlertStats;
}

export function DashboardContent({ initialAlerts, stats }: DashboardContentProps) {
  const router = useRouter();
  const {
    filters,
    updateFilters,
    resetFilters,
    alerts,
    isLoading,
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
  } = useAlertFilters({ initialAlerts, statsTimeBounds: stats.timeBounds });

  // Force re-render every minute to update relative times
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <FilterBar
        filters={filters}
        onFiltersChange={updateFilters}
        onReset={resetFilters}
        scenarios={stats.allScenarios}
        machines={machines}
        countries={stats.allCountries ?? []}
        timeBounds={timeBounds}
        hasActiveFilters={hasActiveFilters}
        isLoading={isLoading}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Map */}
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Alert Origins</h2>
          <Suspense fallback={<div className="h-[400px] bg-slate-100 animate-pulse rounded-lg" />}>
            {/* Clicking a cluster filters the list on its country (kept in the URL) */}
            <WorldMapWrapper
              alerts={alerts}
              onCountrySelect={(country) => updateFilters({ country })}
            />
          </Suspense>
        </div>

        {/* Recent Alerts */}
        <div className="card p-4 max-h-[500px] overflow-hidden flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Recent Alerts</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={refresh}
                disabled={isLoading}
                className="h-7 w-7 p-0"
                title="Refresh"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
            <div className="text-right">
              <span className="text-sm text-slate-500">
                {alertCountLabel(alerts.length, hasMore)}
              </span>
              <div className="text-xs text-slate-400">
                Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onClick={() => router.push(alertDetailHref(alert.id, persistFilters()))}
              />
            ))}

            {alerts.length === 0 && (
              <div className="text-center text-slate-400 py-8">
                <p>No alerts match the current filters</p>
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-2">
                    Reset
                  </Button>
                )}
              </div>
            )}

            <LoadMoreAlerts
              hasMore={hasMore && alerts.length > 0}
              isLoadingMore={isLoadingMore}
              error={loadMoreError}
              onLoadMore={loadMore}
            />
          </div>
        </div>
      </div>

      {/* Top Scenarios */}
      {stats.topScenarios.length > 0 && (
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Top Scenarios</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {stats.topScenarios.slice(0, 5).map((item) => (
              <div
                key={item.scenario}
                className="bg-slate-50 rounded-lg p-3 cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={() => updateFilters({ scenario: item.scenario })}
              >
                <div className="text-sm font-medium truncate" title={item.scenario}>
                  {item.scenario}
                </div>
                <div className="text-2xl font-bold text-crowdsec-primary">{item.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
