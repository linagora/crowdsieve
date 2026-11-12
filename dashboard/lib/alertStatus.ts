import type { StoredAlert } from './types';

/**
 * Visual kind of an alert row. Locally-recorded audit events are operator
 * actions, so they get their own badge instead of the filtered/forwarded
 * status badges.
 */
export type AlertKind = 'alert' | 'unban' | 'manual-ban' | 'audit';

type AlertKindSource = Pick<StoredAlert, 'localAudit' | 'scenario'>;
type AlertStatusSource = AlertKindSource & Pick<StoredAlert, 'filtered' | 'forwardedToCapi'>;

export function getAlertKind(alert: AlertKindSource): AlertKind {
  if (!alert.localAudit) return 'alert';
  if (alert.scenario === 'crowdsieve/unban') return 'unban';
  if (alert.scenario === 'crowdsieve/manual-audit') return 'manual-ban';
  return 'audit';
}

/**
 * Audit rows are stored with `filtered=true` defensively so they are never
 * forwarded to CAPI, but they were not rejected by the filter rules. Only real
 * alerts may display the Filtered badge.
 */
export function showsFilteredBadge(alert: AlertStatusSource): boolean {
  return getAlertKind(alert) === 'alert' && alert.filtered;
}

/** Same reasoning as `showsFilteredBadge` for the forwarded status. */
export function showsForwardedBadge(alert: AlertStatusSource): boolean {
  return getAlertKind(alert) === 'alert' && alert.forwardedToCapi;
}
