/**
 * Client-side CSV / JSON export of dashboard lists.
 *
 * The generic helpers (`toCsv`, `toJson`, `fetchAllPages`, `exportFileName`,
 * `downloadExport`) are list-agnostic; each list provides its own columns
 * (see `ALERT_EXPORT_COLUMNS`, `DECISION_EXPORT_COLUMNS`).
 */
import type { Decision, DecisionSearchResponse, StoredAlert } from './types';

export type ExportFormat = 'csv' | 'json';

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/** Most alerts an export fetches; above that it keeps the newest ones. */
export const MAX_EXPORT_ALERTS = 10_000;

export const ALERT_EXPORT_TRUNCATED_NOTICE =
  'Export limited to the 10,000 newest alerts: narrow the filters to export older ones';

// Leading characters that make spreadsheets read a cell as a formula
// (OWASP "CSV injection"): =, +, -, @, tab and carriage return.
const FORMULA_START_RE = /^[=+\-@\t\r]/;

/**
 * Format one CSV cell (RFC 4180).
 *
 * Text starting with a formula character gets a leading apostrophe so that
 * spreadsheets show it as text instead of evaluating it. Numbers and booleans
 * come from typed fields, not from free text, and are written as is.
 * A cell is quoted when it holds a comma, a double quote or a line break, and
 * its double quotes are doubled.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    text = typeof value === 'string' ? value : JSON.stringify(value);
    if (FORMULA_START_RE.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV document with a header row, CRLF line endings (RFC 4180). */
export function toCsv<T>(rows: readonly T[], columns: readonly ExportColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Pretty-printed JSON array. */
export function toJson(rows: readonly unknown[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** `<prefix>-<YYYYMMDD-HHmm>.<ext>`, in local time. */
export function exportFileName(prefix: string, format: ExportFormat, date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${prefix}-${stamp}.${format}`;
}

export interface FetchAllPagesOptions {
  /** Rows requested per page. */
  pageSize: number;
  /** Most rows to return; `truncated` tells whether more exist. */
  maxRows: number;
  /** Called with the number of rows fetched so far after each page. */
  onProgress?: (fetched: number) => void;
}

/**
 * Fetch a paginated list page by page (`fetchPage(offset, limit)`) until a
 * page comes back short or `maxRows` is reached. One extra row is requested
 * on the last page to tell whether the list goes beyond `maxRows`.
 */
export async function fetchAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  { pageSize, maxRows, onProgress }: FetchAllPagesOptions
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (;;) {
    const limit = Math.min(pageSize, maxRows + 1 - rows.length);
    const page = await fetchPage(rows.length, limit);
    rows.push(...page);
    onProgress?.(Math.min(rows.length, maxRows));
    if (rows.length > maxRows) {
      return { rows: rows.slice(0, maxRows), truncated: true };
    }
    if (page.length < limit) {
      return { rows, truncated: false };
    }
  }
}

/** Serialise rows in the requested format. */
export function serializeExport<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  format: ExportFormat
): string {
  return format === 'csv' ? toCsv(rows, columns) : toJson(rows);
}

/** Make the browser download `content` as `fileName`. */
export function downloadExport(content: string, fileName: string, format: ExportFormat): void {
  // The BOM lets spreadsheet applications detect UTF-8.
  const blob =
    format === 'csv'
      ? new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' })
      : new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** UTC ISO 8601 form of a stored timestamp, or the value unchanged. */
function isoUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toISOString();
}

/** Filter reasons are stored as a JSON array of strings. */
function joinFilterReasons(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).join('; ');
  } catch {
    // not JSON: export the raw text
  }
  return value;
}

export const ALERT_EXPORT_COLUMNS: readonly ExportColumn<StoredAlert>[] = [
  { header: 'id', value: (a) => a.id },
  { header: 'received_at', value: (a) => isoUtc(a.receivedAt) },
  { header: 'scenario', value: (a) => a.scenario },
  { header: 'source_ip', value: (a) => a.sourceIp },
  { header: 'source_range', value: (a) => a.sourceRange },
  { header: 'country', value: (a) => a.geoCountryCode },
  { header: 'machine', value: (a) => a.machineId },
  { header: 'events_count', value: (a) => a.eventsCount },
  { header: 'has_decision', value: (a) => a.hasDecisions },
  { header: 'filtered', value: (a) => a.filtered },
  { header: 'filter_reasons', value: (a) => joinFilterReasons(a.filterReasons) },
  { header: 'forwarded_to_capi', value: (a) => a.forwardedToCapi },
  { header: 'simulated', value: (a) => a.simulated },
  { header: 'actor', value: (a) => a.actor },
  { header: 'message', value: (a) => a.message },
];

/** A decision of a decision search, with the server it was found on. */
export interface DecisionExportRow extends Decision {
  /** LAPI server name, or "shared" for CAPI / blocklist decisions. */
  server: string;
}

export const SHARED_DECISIONS_SERVER = 'shared';

/** Flatten a decision search response: shared decisions first, then per server. */
export function decisionSearchExportRows(response: DecisionSearchResponse): DecisionExportRow[] {
  return [
    ...response.shared.map((d) => ({ ...d, server: SHARED_DECISIONS_SERVER })),
    ...response.results.flatMap((r) => r.decisions.map((d) => ({ ...d, server: r.server }))),
  ];
}

export const DECISION_EXPORT_COLUMNS: readonly ExportColumn<DecisionExportRow>[] = [
  { header: 'server', value: (d) => d.server },
  { header: 'id', value: (d) => d.id },
  { header: 'type', value: (d) => d.type },
  { header: 'scope', value: (d) => d.scope },
  { header: 'value', value: (d) => d.value },
  { header: 'origin', value: (d) => d.origin },
  { header: 'scenario', value: (d) => d.scenario },
  { header: 'duration', value: (d) => d.duration },
  { header: 'until', value: (d) => isoUtc(d.until) },
];
