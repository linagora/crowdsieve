import type { StoredAlert } from './types';

/** Most frequent country code among the alerts of a cluster, if any. */
export function clusterCountry(alerts: Pick<StoredAlert, 'geoCountryCode'>[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  for (const alert of alerts) {
    const code = alert.geoCountryCode;
    if (!code) continue;
    const count = (counts.get(code) ?? 0) + 1;
    counts.set(code, count);
    if (best === null || count > (counts.get(best) ?? 0)) best = code;
  }
  return best;
}
