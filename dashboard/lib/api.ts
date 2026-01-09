import type { StoredAlert } from './types';

// Client-side API functions - these call Next.js API routes (not the backend directly)
// This avoids CORS issues since requests stay same-origin

export async function fetchAlerts(params?: {
  limit?: number;
  offset?: number;
  filtered?: boolean;
  scenario?: string;
  country?: string;
  since?: string;
  until?: string;
  machineId?: string;
}): Promise<StoredAlert[]> {
  const searchParams = new URLSearchParams();

  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());
  if (params?.filtered !== undefined) searchParams.set('filtered', params.filtered.toString());
  if (params?.scenario) searchParams.set('scenario', params.scenario);
  if (params?.country) searchParams.set('country', params.country);
  if (params?.since) searchParams.set('since', params.since);
  if (params?.until) searchParams.set('until', params.until);
  if (params?.machineId) searchParams.set('machineId', params.machineId);

  // Calls Next.js API route which proxies to backend
  const res = await fetch(`/api/alerts?${searchParams}`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error('Failed to fetch alerts');
  }

  return res.json();
}
