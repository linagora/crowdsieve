import { StatsPanel } from '@/components/StatsPanel';
import { DashboardContent } from '@/components/DashboardContent';
import { BanIPForm } from '@/components/BanIPForm';
import { ApiError } from '@/components/ApiError';
import type { StoredAlert, AlertStats } from '@/lib/types';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

// Read env vars inside functions to ensure they're evaluated at runtime (not build time)
function getApiConfig() {
  return {
    apiBase: process.env.API_URL || 'http://localhost:8080',
    apiKey: process.env.DASHBOARD_API_KEY,
  };
}

function getApiHeaders(): HeadersInit {
  const { apiKey } = getApiConfig();
  const headers: HeadersInit = {};
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

async function fetchApi<T>(url: string, defaultValue: T): Promise<ApiResult<T>> {
  const { apiKey } = getApiConfig();

  // Check if API key is configured on dashboard side
  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      return { success: false, error: 'unauthorized', details: body };
    }

    if (res.status === 500) {
      const body = await res.text().catch(() => '');
      if (body.includes('API key not set')) {
        return { success: false, error: 'unauthorized', details: 'Proxy API key not configured' };
      }
    }

    if (!res.ok) {
      return { success: true, data: defaultValue };
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

async function getAlerts(): Promise<ApiResult<StoredAlert[]>> {
  const { apiBase } = getApiConfig();
  return fetchApi(`${apiBase}/api/alerts?limit=100`, []);
}

async function getStats(): Promise<ApiResult<AlertStats>> {
  const { apiBase } = getApiConfig();
  const defaultStats: AlertStats = {
    total: 0,
    filtered: 0,
    forwarded: 0,
    topScenarios: [],
    topCountries: [],
    timeBounds: { min: null, max: null },
  };
  return fetchApi(`${apiBase}/api/stats`, defaultStats);
}

export default async function DashboardPage() {
  const [alertsResult, statsResult] = await Promise.all([getAlerts(), getStats()]);

  // Check for errors - prioritize showing the first error
  if (!alertsResult.success) {
    return <ApiError type={alertsResult.error} details={alertsResult.details} />;
  }
  if (!statsResult.success) {
    return <ApiError type={statsResult.error} details={statsResult.details} />;
  }

  const alerts = alertsResult.data;
  const stats = statsResult.data;

  return (
    <div className="space-y-6">
      {/* Stats Panel */}
      <StatsPanel stats={stats} />

      {/* Dashboard Content with Filters */}
      <DashboardContent initialAlerts={alerts} stats={stats} />

      {/* Manual Ban */}
      <BanIPForm />
    </div>
  );
}
