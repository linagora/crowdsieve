import { ApiError } from '@/components/ApiError';
import { FiltersContent } from '@/components/FiltersContent';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { periodSince, type FilterRuleStats, type FilterRulesResponse } from '@/lib/filterRules';
import { requirePageAuth } from '@/lib/auth/guard';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

async function fetchApi<T>(path: string): Promise<ApiResult<T | null>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const res = await fetch(`${apiBase}${path}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }

    if (!res.ok) {
      return { success: true, data: null };
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

export default async function FiltersPage() {
  await requirePageAuth();

  const since = periodSince('30d');
  const [rulesResult, statsResult] = await Promise.all([
    fetchApi<FilterRulesResponse>('/api/filters'),
    fetchApi<FilterRuleStats>(
      `/api/filters/stats${since ? `?since=${encodeURIComponent(since.toISOString())}` : ''}`
    ),
  ]);

  if (!rulesResult.success) {
    return <ApiError type={rulesResult.error} details={rulesResult.details} />;
  }

  return (
    <FiltersContent
      rules={rulesResult.data}
      initialStats={statsResult.success ? statsResult.data : null}
    />
  );
}
