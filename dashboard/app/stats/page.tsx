import { ApiError } from '@/components/ApiError';
import { StatsContent } from '@/components/StatsContent';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import type { TimeDistributionStats } from '@/lib/types';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

async function getDistributionStats(period?: string): Promise<ApiResult<TimeDistributionStats>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  const defaultStats: TimeDistributionStats = {
    byDayOfWeek: [],
    byHourOfDay: [],
    byCountry: [],
    byScenario: [],
    dailyTrend: [],
    totalAlerts: 0,
    dateRange: { from: null, to: null },
  };

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
      return { success: true, data: defaultStats };
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
  const result = await getDistributionStats();

  if (!result.success) {
    return <ApiError type={result.error} details={result.details} />;
  }

  return <StatsContent initialStats={result.data} />;
}
