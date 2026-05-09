import { ApiError } from '@/components/ApiError';
import { BouncersContent } from '@/components/BouncersContent';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import type { BouncerMetric, BouncerName } from '@/lib/types';

interface StatsBlocked {
  blockedRequests: number;
}

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

async function getBouncerNames(): Promise<ApiResult<{ bouncers: BouncerName[] }>> {
  const { apiBase, apiKey } = getApiConfig();
  if (!apiKey) return { success: false, error: 'no_api_key' };

  try {
    const res = await fetch(`${apiBase}/api/bouncer-metrics/names`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }
    if (!res.ok) {
      return { success: true, data: { bouncers: [] } };
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

async function getBlockedRequests(): Promise<number> {
  const { apiBase, apiKey } = getApiConfig();
  if (!apiKey) return 0;
  try {
    const res = await fetch(`${apiBase}/api/stats`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as Partial<StatsBlocked>;
    return data.blockedRequests ?? 0;
  } catch {
    return 0;
  }
}

async function getInitialMetrics(): Promise<ApiResult<BouncerMetric[]>> {
  const { apiBase, apiKey } = getApiConfig();
  if (!apiKey) return { success: false, error: 'no_api_key' };

  try {
    const res = await fetch(`${apiBase}/api/bouncer-metrics?limit=500`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }
    if (!res.ok) {
      return { success: true, data: [] };
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

export default async function BouncersPage() {
  const [namesResult, metricsResult, blockedRequests] = await Promise.all([
    getBouncerNames(),
    getInitialMetrics(),
    getBlockedRequests(),
  ]);

  if (!namesResult.success) {
    return <ApiError type={namesResult.error} details={namesResult.details} />;
  }

  const initialMetrics = metricsResult.success ? metricsResult.data : [];

  return (
    <BouncersContent
      initialBouncers={namesResult.data.bouncers}
      initialMetrics={initialMetrics}
      initialBlockedRequests={blockedRequests}
    />
  );
}
