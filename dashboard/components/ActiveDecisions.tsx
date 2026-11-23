'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ListChecks, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UnbanConfirmation } from '@/components/UnbanConfirmation';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import type { ActiveDecisionsResponse, LapiServer } from '@/lib/types';
import {
  DEFAULT_ACTIVE_DECISION_FILTERS,
  buildActiveDecisionsQuery,
  flattenActiveDecisions,
  formatPageRange,
  ipOrCidrKind,
  pageWindow,
  parseActiveDecisionParams,
  writeActiveDecisionParams,
  type ActiveDecisionFilters,
  type ActiveDecisionRow,
} from '@/lib/activeDecisions';
import { formatExpiryDate, formatRemainingPhrase } from '@/lib/decisionExpiry';
import {
  bulkUnban,
  makeDeleteDecision,
  summarizeUnbanResults,
  type UnbanTarget,
} from '@/lib/bulkUnban';

// Delay before applying typed filters (fetch) and writing them into the URL.
const FILTER_DELAY = 300;
// Refresh of the "in 3h 56m" remaining times.
const CLOCK_INTERVAL = 30_000;

const TYPE_OPTIONS = ['ban', 'captcha'];
const LOCAL_ORIGIN_OPTIONS = ['crowdsec', 'cscli', 'crowdsieve'];
const SHARED_ORIGIN_OPTIONS = ['CAPI', 'lists'];

const deleteDecision = makeDeleteDecision(fetchWithAuth);

interface ActiveDecisionsProps {
  /**
   * Show the selection checkboxes, the delete buttons and the bulk delete.
   * Read-only users get `false` (and only see the list).
   */
  canWrite: boolean;
}

interface LoadedData {
  results: ActiveDecisionsResponse['results'];
  /** Time the answer was received: base of the LAPI relative durations. */
  answeredAt: number;
}

interface Summary {
  text: string;
  ok: boolean;
}

function buildFilterUrl(filters: ActiveDecisionFilters): string {
  const params = new URLSearchParams(window.location.search);
  writeActiveDecisionParams(params, filters);
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
}

function withCurrent(options: string[], current: string | null): string[] {
  return current && !options.includes(current) ? [...options, current] : options;
}

function TypeBadge({ type }: { type: string }) {
  const lower = type.toLowerCase();
  const color =
    lower === 'ban'
      ? 'bg-red-100 text-red-700'
      : lower === 'captcha'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-700';
  return <span className={`text-xs px-2 py-0.5 rounded font-medium ${color}`}>{type}</span>;
}

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <tr key={i} className="border-t border-slate-100">
          {Array.from({ length: columns }, (_, j) => (
            <td key={j} className="px-3 py-3">
              <div className="h-4 bg-slate-100 rounded animate-pulse" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function SelectAllCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label="Select all decisions of this page"
      className="h-4 w-4"
    />
  );
}

export function ActiveDecisions({ canWrite }: ActiveDecisionsProps) {
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const [filters, setFilters] = useState<ActiveDecisionFilters>(() =>
    parseActiveDecisionParams(searchParams)
  );
  // Last query string written here, to tell our URL updates from navigations
  const lastSearchKeyRef = useRef(searchKey);

  const [servers, setServers] = useState<LapiServer[]>([]);
  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [rowConfirmKey, setRowConfirmKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const requestIdRef = useRef(0);

  const valueKind = filters.value.trim() ? ipOrCidrKind(filters.value) : null;
  const invalidValue = filters.value.trim() !== '' && valueKind === null;
  const queryKey = buildActiveDecisionsQuery(filters).toString();
  const [appliedQueryKey, setAppliedQueryKey] = useState(queryKey);

  // Follow external URL changes (e.g. the "Decisions" menu entry)
  useEffect(() => {
    if (searchKey === lastSearchKeyRef.current) return;
    lastSearchKeyRef.current = searchKey;
    setFilters(parseActiveDecisionParams(new URLSearchParams(searchKey)));
  }, [searchKey]);

  // Apply the filters (fetch) and write them into the URL, debounced
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedQueryKey(queryKey);
      const url = buildFilterUrl(filters);
      if (url !== `${window.location.pathname}${window.location.search}`) {
        lastSearchKeyRef.current = new URLSearchParams(url.split('?')[1] ?? '').toString();
        window.history.replaceState(null, '', url);
      }
    }, FILTER_DELAY);
    return () => clearTimeout(timer);
  }, [filters, queryKey]);

  // New filters: back to the first page, nothing selected
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
    setRowConfirmKey(null);
    setBulkConfirmOpen(false);
  }, [appliedQueryKey]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/lapi-servers')
      .then((res) => (res.ok ? res.json() : []))
      .then((list: LapiServer[]) => {
        if (!cancelled && Array.isArray(list)) setServers(list);
      })
      .catch(() => {
        // The server filter then only offers "All servers".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (invalidValue) {
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    fetchWithAuth(`/api/decisions/active${appliedQueryKey ? `?${appliedQueryKey}` : ''}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (requestId !== requestIdRef.current) return;
        if (!res.ok || !body || !Array.isArray(body.results)) {
          setError(body?.error || 'Failed to list active decisions');
          setData(null);
          return;
        }
        const answeredAt = Date.now();
        setData({ results: body.results, answeredAt });
        setNow(answeredAt);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to list active decisions');
        setData(null);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [appliedQueryKey, reloadToken, invalidValue]);

  const rows = useMemo(
    () => (data ? flattenActiveDecisions(data.results, data.answeredAt) : []),
    [data]
  );

  // Drop selected decisions that are no longer listed (after a reload)
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keys = new Set(rows.map((r) => r.key));
      const kept = new Set([...prev].filter((k) => keys.has(k)));
      return kept.size === prev.size ? prev : kept;
    });
  }, [rows]);

  const serverCanDelete = useMemo(() => {
    const map = new Map(servers.map((s) => [s.name, s.canBan]));
    // Unknown server (list not loaded): let the delete route answer.
    return (server: string) => map.get(server) ?? true;
  }, [servers]);

  const isDeletable = useCallback(
    (row: ActiveDecisionRow) => canWrite && !row.shared && serverCanDelete(row.server),
    [canWrite, serverCanDelete]
  );

  const pageInfo = pageWindow(rows.length, page);
  const pageRows = rows.slice(pageInfo.start, pageInfo.end);
  const deletablePageRows = pageRows.filter(isDeletable);
  const selectedOnPage = deletablePageRows.filter((r) => selected.has(r.key)).length;
  const selectedRows = rows.filter((r) => selected.has(r.key) && isDeletable(r));
  const serverErrors = data?.results.filter((r) => r.error) ?? [];
  const truncated = data?.results.filter((r) => r.truncated) ?? [];
  const columns = canWrite ? 8 : 6;

  const updateFilters = (updates: Partial<ActiveDecisionFilters>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  };

  const toggleRow = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const togglePage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of deletablePageRows) {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      }
      return next;
    });
  };

  const reload = () => setReloadToken((t) => t + 1);

  const runDelete = async (targets: UnbanTarget[], reason: string) => {
    setDeleting(true);
    setSummary(null);
    setProgress({ done: 0, total: targets.length });
    try {
      const results = await bulkUnban(targets, reason, deleteDecision, undefined, (done, total) =>
        setProgress({ done, total })
      );
      return results;
    } finally {
      setDeleting(false);
      setProgress(null);
    }
  };

  const handleBulkConfirm = async (reason: string) => {
    const targets = selectedRows.map((r) => ({
      server: r.server,
      id: r.decision.id,
      value: r.decision.value,
    }));
    if (targets.length === 0) return;
    const results = await runDelete(targets, reason);
    setSummary({ text: summarizeUnbanResults(results), ok: results.every((r) => r.ok) });
    setBulkConfirmOpen(false);
    setSelected(new Set());
    reload();
  };

  const handleRowConfirm = async (row: ActiveDecisionRow, reason: string) => {
    setRowError(null);
    const [result] = await runDelete(
      [{ server: row.server, id: row.decision.id, value: row.decision.value }],
      reason
    );
    if (!result.ok) {
      setRowError(result.error ?? 'Failed to delete decision');
      return;
    }
    setSummary({ text: summarizeUnbanResults([result]), ok: true });
    setRowConfirmKey(null);
    reload();
  };

  const originOptions = withCurrent(
    filters.includeShared
      ? [...LOCAL_ORIGIN_OPTIONS, ...SHARED_ORIGIN_OPTIONS]
      : LOCAL_ORIGIN_OPTIONS,
    filters.origin
  );
  const typeOptions = withCurrent(TYPE_OPTIONS, filters.type);
  const serverOptions = withCurrent(
    servers.map((s) => s.name),
    filters.server
  );

  const selectClass =
    'px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-crowdsec-primary';
  const inputClass =
    'px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary';

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ListChecks className="w-5 h-5" />
          Active decisions
        </h2>
        <Button type="button" variant="outline" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          LAPI server
          <select
            value={filters.server ?? ''}
            onChange={(e) => updateFilters({ server: e.target.value || null })}
            className={selectClass}
          >
            <option value="">All servers</option>
            {serverOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Type
          <select
            value={filters.type ?? ''}
            onChange={(e) => updateFilters({ type: e.target.value || null })}
            className={selectClass}
          >
            <option value="">All</option>
            {typeOptions.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Origin
          <select
            value={filters.origin ?? ''}
            onChange={(e) => updateFilters({ origin: e.target.value || null })}
            className={selectClass}
          >
            <option value="">All</option>
            {originOptions.map((origin) => (
              <option key={origin} value={origin}>
                {origin}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          IP or range
          <input
            type="text"
            value={filters.value}
            onChange={(e) => updateFilters({ value: e.target.value })}
            placeholder="Filter by IP or range"
            maxLength={64}
            aria-invalid={invalidValue}
            className={`${inputClass} font-mono w-56 ${invalidValue ? 'border-red-400' : ''}`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Scenario / reason
          <input
            type="text"
            value={filters.scenario}
            onChange={(e) => updateFilters({ scenario: e.target.value })}
            placeholder="Contains..."
            maxLength={200}
            className={`${inputClass} w-48`}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 py-2">
          <input
            type="checkbox"
            checked={filters.includeShared}
            onChange={(e) =>
              updateFilters({
                includeShared: e.target.checked,
                // A shared origin is only offered with the community blocklists
                origin:
                  !e.target.checked &&
                  filters.origin &&
                  SHARED_ORIGIN_OPTIONS.includes(filters.origin)
                    ? null
                    : filters.origin,
              })
            }
            className="h-4 w-4"
          />
          Include community blocklists (CAPI, lists)
        </label>
        {JSON.stringify(filters) !== JSON.stringify(DEFAULT_ACTIVE_DECISION_FILTERS) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFilters(DEFAULT_ACTIVE_DECISION_FILTERS)}
          >
            Reset
          </Button>
        )}
      </div>
      {invalidValue && (
        <p className="text-sm text-red-600">
          Enter an IP address (decisions that contain it) or a CIDR range (decisions inside it).
        </p>
      )}

      {/* Per-server warnings */}
      {!invalidValue &&
        serverErrors.map((r) => (
          <p
            key={`error-${r.server}`}
            className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {r.server}: {r.error}
          </p>
        ))}
      {!invalidValue &&
        truncated.map((r) => (
          <p
            key={`truncated-${r.server}`}
            className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {r.server}: only the first {r.decisions.length} of {r.total} decisions are listed;
            narrow the filters.
          </p>
        ))}
      {error && !invalidValue && <p className="text-sm text-red-600">{error}</p>}

      {summary && (
        <p
          role="status"
          className={`text-sm rounded px-3 py-2 border ${
            summary.ok
              ? 'text-green-800 bg-green-50 border-green-200'
              : 'text-amber-800 bg-amber-50 border-amber-200'
          }`}
        >
          {summary.text}
        </p>
      )}

      {/* Bulk delete */}
      {canWrite && (selectedRows.length > 0 || bulkConfirmOpen) && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm bg-slate-50 border border-slate-200 rounded px-3 py-2">
            <span>
              <strong>{selectedRows.length}</strong> selected
            </span>
            <span className="text-slate-400">&middot;</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRowConfirmKey(null);
                setBulkConfirmOpen(true);
              }}
              disabled={bulkConfirmOpen || deleting || selectedRows.length === 0}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete selected
            </Button>
            {!bulkConfirmOpen && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-slate-500 hover:text-slate-700 underline"
              >
                Clear selection
              </button>
            )}
          </div>
          {bulkConfirmOpen && (
            <UnbanConfirmation
              title={`Confirm deletion of ${selectedRows.length} decision${
                selectedRows.length === 1 ? '' : 's'
              }`}
              busy={deleting}
              busyLabel={
                progress ? `Deleting ${progress.done}/${progress.total}...` : 'Deleting...'
              }
              onConfirm={handleBulkConfirm}
              onCancel={() => setBulkConfirmOpen(false)}
            />
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              {canWrite && (
                <th className="px-3 py-2 w-8">
                  <SelectAllCheckbox
                    checked={
                      deletablePageRows.length > 0 && selectedOnPage === deletablePageRows.length
                    }
                    indeterminate={selectedOnPage > 0 && selectedOnPage < deletablePageRows.length}
                    disabled={deletablePageRows.length === 0 || deleting}
                    onChange={togglePage}
                  />
                </th>
              )}
              <th className="px-3 py-2">Server</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Origin</th>
              <th className="px-3 py-2">Scenario / reason</th>
              <th className="px-3 py-2">Expires</th>
              {canWrite && <th className="px-3 py-2 w-8" />}
            </tr>
          </thead>
          <tbody>
            {loading && !invalidValue ? (
              <SkeletonRows columns={columns} />
            ) : invalidValue ? null : pageRows.length === 0 ? (
              <tr className="border-t border-slate-100">
                <td colSpan={columns} className="px-3 py-6 text-center text-slate-500">
                  No active decisions match these filters
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const deletable = isDeletable(row);
                const remaining = formatRemainingPhrase(row.expiry, now);
                return (
                  <Fragment key={row.key}>
                    <tr className="border-t border-slate-100 align-top">
                      {canWrite && (
                        <td className="px-3 py-2">
                          {deletable && (
                            <input
                              type="checkbox"
                              checked={selected.has(row.key)}
                              disabled={deleting}
                              onChange={(e) => toggleRow(row.key, e.target.checked)}
                              aria-label={`Select decision ${row.decision.id} on ${row.server}`}
                              className="h-4 w-4"
                            />
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 whitespace-nowrap">{row.server}</td>
                      <td className="px-3 py-2 font-mono break-all">{row.decision.value}</td>
                      <td className="px-3 py-2">
                        <TypeBadge type={row.decision.type} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{row.decision.origin}</td>
                      <td className="px-3 py-2 font-mono text-xs break-all">
                        {row.decision.scenario}
                      </td>
                      <td
                        className="px-3 py-2 whitespace-nowrap"
                        title={`Duration at load time: ${row.decision.duration || 'none'}`}
                      >
                        <div>{formatExpiryDate(row.expiry)}</div>
                        {remaining && <div className="text-xs text-slate-500">{remaining}</div>}
                      </td>
                      {canWrite && (
                        <td className="px-3 py-2">
                          {deletable && rowConfirmKey !== row.key && (
                            <button
                              type="button"
                              onClick={() => {
                                setBulkConfirmOpen(false);
                                setRowError(null);
                                setRowConfirmKey(row.key);
                              }}
                              disabled={deleting}
                              className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                              title="Delete decision"
                              aria-label={`Delete decision ${row.decision.id} on ${row.server}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {canWrite && rowConfirmKey === row.key && (
                      <tr>
                        <td colSpan={columns} className="px-3 pb-3">
                          <UnbanConfirmation
                            title="Confirm deletion of this decision"
                            busy={deleting}
                            error={rowError}
                            onConfirm={(reason) => handleRowConfirm(row, reason)}
                            onCancel={() => {
                              setRowConfirmKey(null);
                              setRowError(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      {!invalidValue && !loading && rows.length > 0 && (
        <div className="flex items-center justify-end gap-3 text-sm text-slate-600">
          {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>{formatPageRange(pageInfo, rows.length)}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage(pageInfo.page - 1)}
            disabled={pageInfo.page === 0}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage(pageInfo.page + 1)}
            disabled={pageInfo.page >= pageInfo.pageCount - 1}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
