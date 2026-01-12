import { StatsPanel } from '@/components/StatsPanel';
import { DashboardContent } from '@/components/DashboardContent';
import { BanIPForm } from '@/components/BanIPForm';
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
    const res = await fetch(`${API_BASE}/api/alerts?limit=100`, {
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
      return {
        total: 0,
        filtered: 0,
        forwarded: 0,
        topScenarios: [],
        topCountries: [],
        timeBounds: { min: null, max: null },
      };
    }
    return res.json();
  } catch {
    return {
      total: 0,
      filtered: 0,
      forwarded: 0,
      topScenarios: [],
      topCountries: [],
      timeBounds: { min: null, max: null },
    };
  }
}

export default async function DashboardPage() {
  const [alerts, stats] = await Promise.all([getAlerts(), getStats()]);

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
