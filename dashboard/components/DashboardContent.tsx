'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { FilterBar } from '@/components/filters/FilterBar';
import { useAlertFilters } from '@/components/hooks/useAlertFilters';
import { AlertCard } from '@/components/AlertCard';
import { WorldMapWrapper } from '@/components/WorldMapWrapper';
import type { StoredAlert, AlertStats } from '@/lib/types';

interface DashboardContentProps {
  initialAlerts: StoredAlert[];
  stats: AlertStats;
}

export function DashboardContent({ initialAlerts, stats }: DashboardContentProps) {
  const router = useRouter();
  const { filters, updateFilters, resetFilters, alerts, isLoading, hasActiveFilters, timeBounds, machines } =
    useAlertFilters({ initialAlerts });

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
          <h2 className="text-lg font-semibold mb-4">Origines des alertes</h2>
          <Suspense fallback={<div className="h-[400px] bg-slate-100 animate-pulse rounded-lg" />}>
            <WorldMapWrapper alerts={alerts} />
          </Suspense>
        </div>

        {/* Recent Alerts */}
        <div className="card p-4 max-h-[500px] overflow-hidden flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">
              Alertes récentes
              {isLoading && (
                <span className="ml-2 text-sm font-normal text-slate-400">Chargement...</span>
              )}
            </h2>
            <span className="text-sm text-slate-500">
              {alerts.length} résultat{alerts.length > 1 ? 's' : ''}
            </span>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onClick={() => router.push(`/alerts/${alert.id}`)}
              />
            ))}

            {alerts.length === 0 && (
              <div className="text-center text-slate-400 py-8">
                Aucune alerte ne correspond aux filtres
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Top Scenarios */}
      {stats.topScenarios.length > 0 && (
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Top Scénarios</h2>
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
