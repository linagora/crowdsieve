'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  ScrollText,
  ShieldOff,
  ShieldPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/LocalDateTime';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { alertDetailHref } from '@/lib/alertFilters';
import { isIpOrCidr } from '@/lib/banForm';
import { auditItemsToCsv } from '@/lib/auditCsv';
import {
  AUDIT_EXPORT_PAGE_SIZE,
  AUDIT_PAGE_SIZE,
  AUDIT_PERIODS,
  AUDIT_PERIOD_LABELS,
  DEFAULT_AUDIT_FILTERS,
  auditCsvFilename,
  auditPageCount,
  auditRangeLabel,
  buildAuditApiQuery,
  formatAuditDetails,
  hasActiveAuditFilters,
  parseAuditParams,
  writeAuditParams,
  type AuditFilters,
  type AuditPeriod,
} from '@/lib/auditFilters';
import type { AuditAction, AuditLogItem, AuditLogPage } from '@/lib/types';

const IP_INPUT_DELAY = 400;

const SELECT_CLASS =
  'px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-crowdsec-primary';

async function fetchAuditPage(query: URLSearchParams): Promise<AuditLogPage> {
  const res = await fetchWithAuth(`/api/audit?${query}`, { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || 'Failed to load the audit log');
  }
  return data as AuditLogPage;
}

function ActionBadge({ action }: { action: AuditAction }) {
  return action === 'unban' ? (
    <span className="badge bg-purple-100 text-purple-800">
      <ShieldOff className="w-3 h-3 mr-1" />
      Unban
    </span>
  ) : (
    <span className="badge bg-orange-100 text-orange-800">
      <ShieldPlus className="w-3 h-3 mr-1" />
      Ban
    </span>
  );
}

export function AuditLogContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const filters = useMemo(() => parseAuditParams(new URLSearchParams(searchKey)), [searchKey]);

  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actors, setActors] = useState<string[]>([]);
  const [ipInput, setIpInput] = useState(filters.ip ?? '');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const currentHref = `${pathname}${searchKey ? `?${searchKey}` : ''}`;

  const updateFilters = useCallback(
    (updates: Partial<AuditFilters>) => {
      const params = new URLSearchParams(window.location.search);
      // Any filter change goes back to the first page.
      writeAuditParams(params, { ...filters, page: 1, ...updates });
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [filters, pathname, router]
  );

  // Users of the User filter
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/audit/actors', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { actors: [] }))
      .then((data: { actors?: string[] }) => {
        if (!cancelled) setActors(data.actors ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Rows of the current page
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = buildAuditApiQuery(filters, new Date(), {
      limit: AUDIT_PAGE_SIZE,
      offset: (filters.page - 1) * AUDIT_PAGE_SIZE,
    });
    fetchAuditPage(query)
      .then((data) => {
        if (!cancelled) setPage(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPage(null);
          setError(err instanceof Error ? err.message : 'Failed to load the audit log');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  // Follow URL changes (back button, reset) in the IP field
  useEffect(() => {
    setIpInput(filters.ip ?? '');
  }, [filters.ip]);

  const trimmedIp = ipInput.trim();
  const ipInputValid = trimmedIp === '' || isIpOrCidr(trimmedIp);

  // Apply the IP filter once the user stops typing a valid value
  useEffect(() => {
    if (!ipInputValid || (trimmedIp || null) === filters.ip) return;
    const timer = setTimeout(() => updateFilters({ ip: trimmedIp || null }), IP_INPUT_DELAY);
    return () => clearTimeout(timer);
  }, [trimmedIp, ipInputValid, filters.ip, updateFilters]);

  const goToPage = (n: number) => {
    const params = new URLSearchParams(window.location.search);
    writeAuditParams(params, { ...filters, page: n });
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      // Pin the upper bound so rows recorded meanwhile do not shift the pages.
      const now = new Date();
      const items: AuditLogItem[] = [];
      for (let offset = 0; ; offset += AUDIT_EXPORT_PAGE_SIZE) {
        const data = await fetchAuditPage(
          buildAuditApiQuery(filters, now, { limit: AUDIT_EXPORT_PAGE_SIZE, offset, until: now })
        );
        items.push(...data.items);
        if (data.items.length < AUDIT_EXPORT_PAGE_SIZE || items.length >= data.total) break;
      }
      const blob = new Blob([auditItemsToCsv(items)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = auditCsvFilename(now);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const offset = (filters.page - 1) * AUDIT_PAGE_SIZE;
  const pageCount = auditPageCount(total);
  // Keep a user selected through the URL even if it is not listed (yet).
  const actorOptions =
    filters.actor && !actors.includes(filters.actor) ? [filters.actor, ...actors] : actors;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ScrollText className="w-6 h-6" />
          Audit log
        </h1>
        <Button
          variant="outline"
          onClick={handleExport}
          disabled={exporting || loading || total === 0}
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>
      <p className="text-sm text-slate-500 -mt-4">
        Manual bans and unbans issued from this console, with who did them and why.
      </p>
      {exportError && <p className="text-sm text-red-600">{exportError}</p>}

      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-user" className="text-xs font-medium text-slate-500">
            User
          </label>
          <select
            id="audit-user"
            value={filters.actor ?? ''}
            onChange={(e) => updateFilters({ actor: e.target.value || null })}
            className={`${SELECT_CLASS} min-w-[220px]`}
          >
            <option value="">All users</option>
            {actorOptions.map((actor) => (
              <option key={actor} value={actor}>
                {actor}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="audit-action" className="text-xs font-medium text-slate-500">
            Action
          </label>
          <select
            id="audit-action"
            value={filters.action}
            onChange={(e) => updateFilters({ action: e.target.value as AuditFilters['action'] })}
            className={SELECT_CLASS}
          >
            <option value="all">All</option>
            <option value="ban">Ban</option>
            <option value="unban">Unban</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="audit-ip" className="text-xs font-medium text-slate-500">
            IP or range
          </label>
          <input
            id="audit-ip"
            type="text"
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            placeholder="198.51.100.7 or 10.0.0.0/8"
            className={`${SELECT_CLASS} font-mono w-56 ${ipInputValid ? '' : 'border-red-400'}`}
            aria-invalid={ipInputValid ? undefined : true}
            aria-describedby="audit-ip-error"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="audit-period" className="text-xs font-medium text-slate-500">
            Period
          </label>
          <select
            id="audit-period"
            value={filters.period}
            onChange={(e) => updateFilters({ period: e.target.value as AuditPeriod })}
            className={SELECT_CLASS}
          >
            {AUDIT_PERIODS.map((period) => (
              <option key={period} value={period}>
                {AUDIT_PERIOD_LABELS[period]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          {hasActiveAuditFilters(filters) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateFilters(DEFAULT_AUDIT_FILTERS)}
              className="text-slate-500 hover:text-slate-700"
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Reset
            </Button>
          )}
        </div>
        {!ipInputValid && (
          <p id="audit-ip-error" className="basis-full text-xs text-red-600">
            Enter an IP address or a CIDR range
          </p>
        )}
      </div>

      {error ? (
        <div className="card p-6 bg-red-50 border-red-200">
          <p className="text-red-700">{error}</p>
        </div>
      ) : !loading && items.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No manual ban or unban matches these filters
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">IP or range</th>
                <th className="px-4 py-3">Server</th>
                <th className="px-4 py-3">Details</th>
                <th className="px-4 py-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => {
                const detailHref = alertDetailHref(item.id, currentHref);
                return (
                  <tr
                    key={item.id}
                    onClick={() => router.push(detailHref)}
                    className="hover:bg-slate-50 cursor-pointer align-top"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link
                        href={detailHref}
                        onClick={(e) => e.stopPropagation()}
                        className="text-slate-800 hover:text-crowdsec-primary hover:underline"
                      >
                        <LocalDateTime value={item.at} />
                      </Link>
                      <div className="text-xs text-slate-400">
                        {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                      </div>
                    </td>
                    <td className="px-4 py-3 break-all">
                      {item.actor ?? <span className="text-slate-400">unknown</span>}
                    </td>
                    <td className="px-4 py-3">
                      <ActionBadge action={item.action} />
                    </td>
                    <td className="px-4 py-3 font-mono whitespace-nowrap">
                      {item.ip ? (
                        <Link
                          href={`/decisions?ip=${encodeURIComponent(item.ip)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-crowdsec-primary hover:underline"
                        >
                          {item.ip}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono">{item.server ?? '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatAuditDetails(item) || '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 break-words max-w-md">{item.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-slate-100 text-sm text-slate-600">
            <span>{auditRangeLabel(offset, items.length, total)}</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(filters.page - 1)}
                disabled={loading || filters.page <= 1}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(filters.page + 1)}
                disabled={loading || filters.page >= pageCount}
              >
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
