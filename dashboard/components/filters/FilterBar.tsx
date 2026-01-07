'use client';

import { RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TimeRangeSlider } from './TimeRangeSlider';
import { ScenarioFilter } from './ScenarioFilter';
import type { FilterState } from '@/components/hooks/useAlertFilters';

interface FilterBarProps {
  filters: FilterState;
  onFiltersChange: (updates: Partial<FilterState>) => void;
  onReset: () => void;
  scenarios: Array<{ scenario: string; count: number }>;
  timeBounds: { min: Date; max: Date };
  hasActiveFilters: boolean;
  isLoading?: boolean;
}

export function FilterBar({
  filters,
  onFiltersChange,
  onReset,
  scenarios,
  timeBounds,
  hasActiveFilters,
  isLoading = false,
}: FilterBarProps) {
  const handleTimeRangeChange = (since: Date | null, until: Date | null) => {
    onFiltersChange({ since, until });
  };

  const handleScenarioChange = (scenario: string | null) => {
    onFiltersChange({ scenario });
  };

  const handleStatusChange = (status: FilterState['status']) => {
    onFiltersChange({ status });
  };

  return (
    <div className="card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">Filters</h3>
        <div className="flex items-center gap-2">
          {isLoading && (
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
          )}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="text-slate-500 hover:text-slate-700"
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Reset
            </Button>
          )}
        </div>
      </div>

      {/* Time Range */}
      <div>
        <label className="text-xs font-medium text-slate-500 mb-2 block">
          Time Range
        </label>
        <TimeRangeSlider
          minDate={timeBounds.min}
          maxDate={timeBounds.max}
          since={filters.since}
          until={filters.until}
          onRangeChange={handleTimeRangeChange}
          isLoading={isLoading}
        />
      </div>

      {/* Scenario and Status filters */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Scenario */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">
            Scenario
          </label>
          <ScenarioFilter
            scenarios={scenarios}
            selectedScenario={filters.scenario}
            onScenarioChange={handleScenarioChange}
            isLoading={isLoading}
          />
        </div>

        {/* Status */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">
            Status
          </label>
          <div className="flex gap-1">
            {(['all', 'filtered', 'forwarded'] as const).map((status) => (
              <Button
                key={status}
                variant={filters.status === status ? 'default' : 'secondary'}
                size="sm"
                onClick={() => handleStatusChange(status)}
                disabled={isLoading}
              >
                {status === 'all' && 'All'}
                {status === 'filtered' && 'Filtered'}
                {status === 'forwarded' && 'Forwarded'}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
