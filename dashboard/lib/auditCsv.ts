/**
 * CSV export of the audit log.
 *
 * Kept in its own module so the cell encoding can later be replaced by the
 * shared export helper without touching the page.
 */
import type { AuditLogItem } from './types';

// Cells starting with one of these may be run as a formula by spreadsheets.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Encode one CSV cell (RFC 4180): quote it when it contains a comma, a quote
 * or a line break, doubling inner quotes. Cells that a spreadsheet could
 * evaluate as a formula are prefixed with `'`.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows joined with CRLF, as RFC 4180 prescribes. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const AUDIT_CSV_HEADER = [
  'id',
  'at',
  'user',
  'action',
  'ip',
  'server',
  'type',
  'duration',
  'reason',
] as const;

export function auditItemsToCsv(items: readonly AuditLogItem[]): string {
  return toCsv([
    AUDIT_CSV_HEADER,
    ...items.map((item) => [
      item.id,
      item.at,
      item.actor,
      item.action,
      item.ip,
      item.server,
      item.type,
      item.duration,
      item.reason,
    ]),
  ]);
}
