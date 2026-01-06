import { AlertsTable } from '@/components/AlertsTable';
import type { StoredAlert } from '@/lib/types';

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

export default async function AlertsPage() {
  const alerts = await getAlerts();

  return (
    <div className="card p-4">
      <AlertsTable initialAlerts={alerts} />
    </div>
  );
}
