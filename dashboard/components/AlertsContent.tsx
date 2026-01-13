'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { FilterBar } from '@/components/filters/FilterBar';
import { useAlertFilters } from '@/components/hooks/useAlertFilters';
import { AlertCard } from '@/components/AlertCard';
import { Button } from '@/components/ui/button';
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
    lastUpdated,
    refresh,
  } = useAlertFilters({ initialAlerts, limit: 200, statsTimeBounds: stats.timeBounds });

  // Force re-render every minute to update relative times
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

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
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">All Alerts</h2>
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
              {alerts.length} result{alerts.length > 1 ? 's' : ''}
            </span>
            <div className="text-xs text-slate-400">
              Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
            </div>
          </div>
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
