import { Suspense } from 'react';
import { StatsPanel } from '@/components/StatsPanel';
import { AlertsTable } from '@/components/AlertsTable';
import { WorldMapWrapper } from '@/components/WorldMapWrapper';
import type { StoredAlert, AlertStats } from '@/lib/types';

// Use internal API route which will be rewritten to proxy
const API_BASE = process.env.API_URL || 'http://localhost:8080';
const API_KEY = process.env.DASHBOARD_API_KEY;

function getApiHeaders(): HeadersInit {
  const headers: HeadersInit = {};
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return headers;
}

async function getAlerts(): Promise<StoredAlert[]> {
  try {
    // In server components, we need the full URL
    const res = await fetch(`${API_BASE}/api/alerts?limit=50`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function getStats(): Promise<AlertStats> {
  try {
    const res = await fetch(`${API_BASE}/api/stats`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    if (!res.ok) {
      return { total: 0, filtered: 0, forwarded: 0, topScenarios: [], topCountries: [] };
    }
    return res.json();
  } catch {
    return { total: 0, filtered: 0, forwarded: 0, topScenarios: [], topCountries: [] };
  }
}

export default async function DashboardPage() {
  const [alerts, stats] = await Promise.all([getAlerts(), getStats()]);

  return (
    <div className="space-y-6">
      {/* Stats Panel */}
      <StatsPanel stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Map */}
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Alert Origins</h2>
          <Suspense fallback={<div className="h-[400px] bg-slate-100 animate-pulse rounded-lg" />}>
            <WorldMapWrapper alerts={alerts} />
          </Suspense>
        </div>

        {/* Recent Alerts */}
        <div className="card p-4 max-h-[500px] overflow-hidden">
          <AlertsTable initialAlerts={alerts} />
        </div>
      </div>

      {/* Top Scenarios */}
      {stats.topScenarios.length > 0 && (
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-4">Top Scenarios</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {stats.topScenarios.slice(0, 5).map((item) => (
              <div key={item.scenario} className="bg-slate-50 rounded-lg p-3">
                <div className="text-sm font-medium truncate" title={item.scenario}>
                  {item.scenario.split('/').pop()}
                </div>
                <div className="text-2xl font-bold text-crowdsec-primary">{item.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
