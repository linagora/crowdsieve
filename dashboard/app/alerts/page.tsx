import { AlertsContent } from '@/components/AlertsContent';
import type { StoredAlert, AlertStats } from '@/lib/types';

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
    const res = await fetch(`${API_BASE}/api/alerts?limit=200`, {
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

export default async function AlertsPage() {
  const [alerts, stats] = await Promise.all([getAlerts(), getStats()]);

  return <AlertsContent initialAlerts={alerts} stats={stats} />;
}
