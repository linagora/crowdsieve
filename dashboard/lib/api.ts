import type { StoredAlert, AlertStats } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export async function fetchAlerts(params?: {
  limit?: number;
  offset?: number;
  filtered?: boolean;
  scenario?: string;
  country?: string;
}): Promise<StoredAlert[]> {
  const searchParams = new URLSearchParams();

  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());
  if (params?.filtered !== undefined) searchParams.set('filtered', params.filtered.toString());
  if (params?.scenario) searchParams.set('scenario', params.scenario);
  if (params?.country) searchParams.set('country', params.country);

  const res = await fetch(`${API_BASE}/api/alerts?${searchParams}`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error('Failed to fetch alerts');
  }

  return res.json();
}

export async function fetchStats(): Promise<AlertStats> {
  const res = await fetch(`${API_BASE}/api/stats`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error('Failed to fetch stats');
  }

  return res.json();
}

export async function fetchAlertById(id: number): Promise<StoredAlert | null> {
  const res = await fetch(`${API_BASE}/api/alerts/${id}`, {
    cache: 'no-store',
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error('Failed to fetch alert');
  }

  return res.json();
}
