import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { StoredAlert } from '@/lib/types';
import { IPInfoPanel } from '@/components/IPInfoPanel';
import { BanIPForm } from '@/components/BanIPForm';
import { IPAlertHistory } from '@/components/IPAlertHistory';
import { ApiError } from '@/components/ApiError';

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
  | {
      success: false;
      error: 'no_api_key' | 'unauthorized' | 'connection_error' | 'not_found';
      details?: string;
    };

async function getAlert(id: string): Promise<ApiResult<StoredAlert>> {
  const { apiBase, apiKey } = getApiConfig();

  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  try {
    const res = await fetch(`${apiBase}/api/alerts/${id}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (res.status === 404) {
      return { success: false, error: 'not_found' };
    }

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
      return { success: false, error: 'connection_error', details: `HTTP ${res.status}` };
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

interface AlertDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function AlertDetailPage({ params }: AlertDetailPageProps) {
  const { id } = await params;
  const result = await getAlert(id);

  if (!result.success) {
    if (result.error === 'not_found') {
      notFound();
    }
    return (
      <ApiError
        type={result.error as 'no_api_key' | 'unauthorized' | 'connection_error'}
        details={result.details}
      />
    );
  }

  const alert = result.data;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/alerts"
        className="text-crowdsec-primary hover:underline flex items-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Alerts
      </Link>

      {/* Alert Header */}
      <div className="card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{alert.scenario}</h1>
            <p className="text-slate-600 mt-1">{alert.message}</p>
          </div>
          <div className="flex gap-2">
            {alert.filtered && (
              <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
                Filtered
              </span>
            )}
            {alert.forwardedToCapi && (
              <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                Forwarded
              </span>
            )}
            {alert.simulated && (
              <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                Simulated
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source Information */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Source</h2>
          <dl className="space-y-3">
            <div className="flex justify-between items-center">
              <dt className="text-slate-600">IP Address</dt>
              <dd className="flex items-center gap-3">
                <span className="font-mono">{alert.sourceValue || alert.sourceIp || 'N/A'}</span>
                {(alert.sourceIp || alert.sourceValue) && (
                  <Link
                    href={`/decisions?ip=${encodeURIComponent(alert.sourceIp || alert.sourceValue || '')}`}
                    className="text-xs px-2 py-1 bg-crowdsec-primary text-white rounded hover:bg-crowdsec-secondary transition-colors"
                  >
                    View decisions
                  </Link>
                )}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Scope</dt>
              <dd>{alert.sourceScope || 'N/A'}</dd>
            </div>
            {alert.sourceCn && (
              <div className="flex justify-between">
                <dt className="text-slate-600">CN</dt>
                <dd>{alert.sourceCn}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* GeoIP Information */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Location</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-600">Country</dt>
              <dd>
                {alert.geoCountryCode && <span className="mr-2">{alert.geoCountryCode}</span>}
                {alert.geoCountryName || 'Unknown'}
              </dd>
            </div>
            {alert.geoCity && (
              <div className="flex justify-between">
                <dt className="text-slate-600">City</dt>
                <dd>{alert.geoCity}</dd>
              </div>
            )}
            {alert.geoLatitude && alert.geoLongitude && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Coordinates</dt>
                <dd className="font-mono text-sm">
                  {alert.geoLatitude.toFixed(4)}, {alert.geoLongitude.toFixed(4)}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Scenario Details */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Scenario</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-600">Name</dt>
              <dd className="font-mono text-sm">{alert.scenario}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Version</dt>
              <dd>{alert.scenarioVersion || 'N/A'}</dd>
            </div>
            {alert.scenarioHash && (
              <div className="flex flex-col">
                <dt className="text-slate-600">Hash</dt>
                <dd className="font-mono text-xs break-all mt-1">{alert.scenarioHash}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-600">Machine ID</dt>
              <dd>{alert.machineId || 'N/A'}</dd>
            </div>
            {alert.eventsCount && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Events Count</dt>
                <dd>{alert.eventsCount}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Timing */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Timing</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-600">Start</dt>
              <dd>{alert.startAt ? new Date(alert.startAt).toLocaleString() : 'N/A'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Stop</dt>
              <dd>{alert.stopAt ? new Date(alert.stopAt).toLocaleString() : 'N/A'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Received</dt>
              <dd>{alert.receivedAt ? new Date(alert.receivedAt).toLocaleString() : 'N/A'}</dd>
            </div>
            {alert.createdAt && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Created</dt>
                <dd>{new Date(alert.createdAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* IP Network Information (Reverse DNS + WHOIS) and Manual Ban */}
      {(alert.sourceIp || alert.sourceValue) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <IPInfoPanel ip={alert.sourceIp || alert.sourceValue || ''} />
          <BanIPForm initialIp={alert.sourceIp || alert.sourceValue || ''} />
        </div>
      )}

      {/* Alert History for this IP */}
      {(alert.sourceIp || alert.sourceValue) && (
        <IPAlertHistory ip={alert.sourceIp || alert.sourceValue || ''} currentAlertId={alert.id} />
      )}

      {/* Filter Information */}
      {alert.filtered && alert.filterReasons && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Filter Reasons</h2>
          <div className="flex flex-wrap gap-2">
            {JSON.parse(alert.filterReasons).map((reason: string, index: number) => (
              <span
                key={index}
                className="px-3 py-1 bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-full text-sm"
              >
                {reason}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* UUID */}
      {alert.uuid && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Identifiers</h2>
          <dl className="space-y-3">
            <div className="flex flex-col">
              <dt className="text-slate-600">UUID</dt>
              <dd className="font-mono text-sm break-all mt-1">{alert.uuid}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Internal ID</dt>
              <dd>{alert.id}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
