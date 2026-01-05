import type { Alert } from '../models/alert.js';

export interface FilterContext {
  alert: Alert;
  machineId?: string;
  timestamp: Date;
}

export interface FilterResult {
  matched: boolean;
  filterName: string;
  reason?: string;
}

export interface Filter {
  name: string;
  enabled: boolean;
  matches(ctx: FilterContext): FilterResult;
}

export interface FilterEngineResult {
  originalCount: number;
  filteredCount: number;
  passedCount: number;
  alerts: Alert[];
  filterDetails: Array<{
    alertIndex: number;
    scenario: string;
    sourceIp?: string;
    filtered: boolean;
    matchedFilters: FilterResult[];
  }>;
}
