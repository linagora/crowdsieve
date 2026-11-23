'use client';

import { RotateCcw, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TimeRangeSlider } from './TimeRangeSlider';
import { ScenarioFilter } from './ScenarioFilter';
import { ServerFilter } from './ServerFilter';
import { CountryFilter, type CountryOption } from './CountryFilter';
import { IpSearchInput } from './IpSearchInput';
import type { FilterState } from '@/components/hooks/useAlertFilters';

interface FilterBarProps {
  filters: FilterState;
  onFiltersChange: (updates: Partial<FilterState>) => void;
  onReset: () => void;
  scenarios: Array<{ scenario: string; count: number }>;
  machines: Array<{ machineId: string; count: number }>;
  countries: CountryOption[];
  timeBounds: { min: Date; max: Date };
  hasActiveFilters: boolean;
  isLoading?: boolean;
}

export function FilterBar({
  filters,
  onFiltersChange,
  onReset,
  scenarios,
  machines,
  countries,
  timeBounds,
  hasActiveFilters,
  isLoading = false,
}: FilterBarProps) {
  const handleTimeRangeChange = (
    since: Date | null,
    until: Date | null,
    range: FilterState['range']
  ) => {
    onFiltersChange({ since, until, range });
  };

  const handleScenarioChange = (scenario: string | null) => {
    onFiltersChange({ scenario });
  };

  const handleMachineChange = (machineId: string | null) => {
    onFiltersChange({ machineId });
  };

  const handleStatusChange = (status: FilterState['status']) => {
    onFiltersChange({ status });
  };

  return (
    <div className="card p-4 space-y-4 relative z-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">Filters</h3>
        <div className="flex items-center gap-2">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
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
        <label className="text-xs font-medium text-slate-500 mb-2 block">Time Range</label>
        <TimeRangeSlider
          minDate={timeBounds.min}
          maxDate={timeBounds.max}
          since={filters.since}
          until={filters.until}
          range={filters.range}
          onRangeChange={handleTimeRangeChange}
          isLoading={isLoading}
        />
      </div>

      {/* IP search, Country, Scenario, Server and Status filters */}
      <div className="flex flex-wrap items-start gap-4">
        {/* IP search */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">Search IP</label>
          <IpSearchInput value={filters.ip} onChange={(ip) => onFiltersChange({ ip })} />
        </div>

        {/* Country */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">Country</label>
          <CountryFilter
            countries={countries}
            selectedCountry={filters.country}
            onCountryChange={(country) => onFiltersChange({ country })}
            isLoading={isLoading}
          />
        </div>

        {/* Scenario */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">Scenario</label>
          <ScenarioFilter
            scenarios={scenarios}
            selectedScenario={filters.scenario}
            onScenarioChange={handleScenarioChange}
            isLoading={isLoading}
          />
        </div>

        {/* Server */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">Server</label>
          <ServerFilter
            machines={machines}
            selectedMachineId={filters.machineId}
            onMachineChange={handleMachineChange}
            isLoading={isLoading}
          />
        </div>

        {/* Status */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-2 block">Status</label>
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

      {/* Active IP / country filters, removable */}
      {(filters.country || filters.ip) && (
        <div className="flex flex-wrap gap-2">
          {filters.ip && (
            <FilterChip
              label={`IP: ${filters.ip}`}
              onRemove={() => onFiltersChange({ ip: null })}
              removeLabel="Remove IP filter"
            />
          )}
          {filters.country && (
            <FilterChip
              label={`Country: ${filters.country}`}
              onRemove={() => onFiltersChange({ country: null })}
              removeLabel="Remove country filter"
            />
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-3 pr-1 text-xs font-medium text-slate-700">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
        aria-label={removeLabel}
        title={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
