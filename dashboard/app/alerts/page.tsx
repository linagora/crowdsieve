import { AlertsTable } from '@/components/AlertsTable';
import type { StoredAlert } from '@/lib/types';

const API_BASE = process.env.API_URL || 'http://localhost:8080';

async function getAlerts(): Promise<StoredAlert[]> {
  try {
    const res = await fetch(`${API_BASE}/api/alerts?limit=100`, {
      cache: 'no-store',
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
