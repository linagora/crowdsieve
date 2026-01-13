'use client';

import { Suspense, useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { FilterBar } from '@/components/filters/FilterBar';
import { useAlertFilters } from '@/components/hooks/useAlertFilters';
import { AlertCard } from '@/components/AlertCard';
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
  } = useAlertFilters({ initialAlerts, statsTimeBounds: stats.timeBounds });

  // Force re-render every minute to update relative times
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Location filter from map marker selection
  const [selectedLocation, setSelectedLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Filter alerts by selected location (client-side)
  const displayedAlerts = useMemo(() => {
    if (!selectedLocation) return alerts;
    // Use numeric comparison with rounding to avoid toFixed string edge cases
    const PRECISION = 10; // 0.1° precision
    const selectedLatRounded = Math.round(selectedLocation.lat * PRECISION);
    const selectedLngRounded = Math.round(selectedLocation.lng * PRECISION);
    return alerts.filter((a) => {
      if (!a.geoLatitude || !a.geoLongitude) return false;
      // Same rounding as WorldMap (0.1°)
      return (
        Math.round(a.geoLatitude * PRECISION) === selectedLatRounded &&
        Math.round(a.geoLongitude * PRECISION) === selectedLngRounded
      );
    });
  }, [alerts, selectedLocation]);

  return (
    <div className="space-y-6">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Map */}
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Alert Origins</h2>
          <Suspense fallback={<div className="h-[400px] bg-slate-100 animate-pulse rounded-lg" />}>
            <WorldMapWrapper alerts={alerts} onLocationSelect={setSelectedLocation} />
          </Suspense>
        </div>

        {/* Recent Alerts */}
        <div className="card p-4 max-h-[500px] overflow-hidden flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">
                Recent Alerts
                {selectedLocation && (
                  <span className="ml-2 text-sm font-normal text-crowdsec-primary">
                    (filtered by location)
                  </span>
                )}
              </h2>
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
                {displayedAlerts.length} result{displayedAlerts.length > 1 ? 's' : ''}
              </span>
              <div className="text-xs text-slate-400">
                Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto">
            {displayedAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onClick={() => router.push(`/alerts/${alert.id}`)}
              />
            ))}

            {displayedAlerts.length === 0 && (
              <div className="text-center text-slate-400 py-8">
                No alerts match the current filters
              </div>
            )}
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
                  {item.scenario.split('/').pop()}
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
