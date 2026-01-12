'use client';

import { useRouter } from 'next/navigation';
import { FilterBar } from '@/components/filters/FilterBar';
import { useAlertFilters } from '@/components/hooks/useAlertFilters';
import { AlertCard } from '@/components/AlertCard';
import type { StoredAlert, AlertStats } from '@/lib/types';

interface AlertsContentProps {
  initialAlerts: StoredAlert[];
  stats: AlertStats;
}

export function AlertsContent({ initialAlerts, stats }: AlertsContentProps) {
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
  } = useAlertFilters({ initialAlerts, limit: 200, statsTimeBounds: stats.timeBounds });

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <FilterBar
        filters={filters}
        onFiltersChange={updateFilters}
        onReset={resetFilters}
        scenarios={stats.topScenarios}
        machines={machines}
        timeBounds={timeBounds}
        hasActiveFilters={hasActiveFilters}
        isLoading={isLoading}
      />

      {/* Alerts List */}
      <div className="card p-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">
            All Alerts
            {isLoading && (
              <span className="ml-2 text-sm font-normal text-slate-400">Loading...</span>
            )}
          </h2>
          <span className="text-sm text-slate-500">
            {alerts.length} result{alerts.length > 1 ? 's' : ''}
          </span>
        </div>

        <div className="space-y-2">
          {alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onClick={() => router.push(`/alerts/${alert.id}`)}
            />
          ))}

          {alerts.length === 0 && (
            <div className="text-center text-slate-400 py-8">
              No alerts match the current filters
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
