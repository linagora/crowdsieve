import { ApiError } from '@/components/ApiError';
import { StatsContent } from '@/components/StatsContent';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import type { TimeDistributionStats, DecisionStats } from '@/lib/types';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

const defaultDistributionStats: TimeDistributionStats = {
  byDayOfWeek: [],
  byHourOfDay: [],
  byCountry: [],
  byScenario: [],
  dailyTrend: [],
  totalAlerts: 0,
  dateRange: { from: null, to: null },
};

const defaultDecisionStats: DecisionStats = {
  totalDecisions: 0,
  byDayOfWeek: [],
  byHourOfDay: [],
  byDurationCategory: [],
  topScenarios: [],
  byCountry: [],
};

async function getDistributionStats(period?: string): Promise<ApiResult<TimeDistributionStats>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const url = period
      ? `${apiBase}/api/stats/distribution?period=${encodeURIComponent(period)}`
      : `${apiBase}/api/stats/distribution`;

    const res = await fetch(url, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }

    if (!res.ok) {
      return { success: true, data: defaultDistributionStats };
    }

    return { success: true, data: await res.json() };
  } catch (err) {
    return {
      success: false,
      error: 'connection_error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function getDecisionStats(period?: string): Promise<ApiResult<DecisionStats>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const url = period
      ? `${apiBase}/api/stats/decisions?period=${encodeURIComponent(period)}`
      : `${apiBase}/api/stats/decisions`;

    const res = await fetch(url, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }

    if (!res.ok) {
      return { success: true, data: defaultDecisionStats };
    }

    return { success: true, data: await res.json() };
  } catch (err) {
    return {
      success: false,
      error: 'connection_error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export default async function StatsPage() {
  const [distributionResult, decisionResult] = await Promise.all([
    getDistributionStats(),
    getDecisionStats(),
  ]);

  if (!distributionResult.success) {
    return <ApiError type={distributionResult.error} details={distributionResult.details} />;
  }

  // Decision stats are optional - don't fail if they're not available
  const decisionStats = decisionResult.success ? decisionResult.data : defaultDecisionStats;

  return (
    <StatsContent initialStats={distributionResult.data} initialDecisionStats={decisionStats} />
  );
}
