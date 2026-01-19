import { ApiError } from '@/components/ApiError';
import { AnalyzersContent } from '@/components/AnalyzersContent';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

export interface AnalyzerStatus {
  id: string;
  name: string;
  enabled: boolean;
  lastRun?: {
    analyzerId: string;
    startedAt: string;
    completedAt: string;
    status: 'success' | 'error';
    logsFetched: number;
    alertsGenerated: number;
    decisionsPushed: number;
    errorMessage?: string;
  };
  nextRun?: string;
  intervalMs: number;
}

export interface AnalyzersData {
  enabled: boolean;
  analyzers: AnalyzerStatus[];
}

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'no_api_key' | 'unauthorized' | 'connection_error'; details?: string };

const defaultData: AnalyzersData = {
  enabled: false,
  analyzers: [],
};

async function getAnalyzers(): Promise<ApiResult<AnalyzersData>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const res = await fetch(`${apiBase}/api/analyzers`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'unauthorized' };
    }

    if (!res.ok) {
      return { success: true, data: defaultData };
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

export default async function AnalyzersPage() {
  const result = await getAnalyzers();

  if (!result.success) {
    return <ApiError type={result.error} details={result.details} />;
  }

  return <AnalyzersContent data={result.data} />;
}
