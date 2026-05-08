'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shield, Activity, Server } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import type { BouncerMetric, BouncerName } from '@/lib/types';

interface BouncersContentProps {
  initialBouncers: BouncerName[];
  initialMetrics: BouncerMetric[];
}

interface SeriesPoint {
  collectedAt: number;
  active: number;
  processed: number;
  dropped: number;
  bytes: number;
}

function buildSeries(rows: BouncerMetric[]): SeriesPoint[] {
  // Rows arrive newest-first from the API; flip to oldest-first for the chart
  // so time flows left-to-right.
  const sorted = [...rows].sort((a, b) => a.collectedAt - b.collectedAt);
  return sorted.map((r) => ({
    collectedAt: r.collectedAt,
    active: r.activeDecisions ?? 0,
    processed: r.processedItems ?? 0,
    dropped: r.droppedItems ?? 0,
    bytes: r.bytesProcessed ?? 0,
  }));
}

interface MiniChartProps {
  data: number[];
  title: string;
  colorClass: string;
}

function MiniChart({ data, title, colorClass }: MiniChartProps) {
  const max = Math.max(...data, 1);
  return (
    <div className="card p-4">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      {data.length > 0 ? (
        <>
          <div className="flex items-end gap-px h-20">
            {data.map((value, i) => (
              <div
                key={i}
                className={`flex-1 ${colorClass} rounded-t min-w-[2px] transition-colors`}
                style={{ height: `${Math.max((value / max) * 100, 2)}%` }}
                title={`${value.toLocaleString()}`}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>{data[0]?.toLocaleString() ?? '0'}</span>
            <span className="font-medium">{(data[data.length - 1] ?? 0).toLocaleString()}</span>
          </div>
        </>
      ) : (
        <div className="text-center text-slate-400 py-6 text-sm">No data</div>
      )}
    </div>
  );
}

export function BouncersContent({ initialBouncers, initialMetrics }: BouncersContentProps) {
  const [bouncers] = useState<BouncerName[]>(initialBouncers);
  const [metrics, setMetrics] = useState<BouncerMetric[]>(initialMetrics);
  const [serverFilter, setServerFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Apply server filter on the metrics view; fetch fresh data when changed.
  useEffect(() => {
    const abort = new AbortController();
    async function refresh() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('limit', '1000');
        if (serverFilter) {
          params.set('machine', serverFilter);
        }
        const res = await fetchWithAuth(`/api/bouncer-metrics?${params.toString()}`, {
          signal: abort.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as BouncerMetric[];
          setMetrics(data);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    return () => abort.abort();
  }, [serverFilter]);

  // Group metrics by (lapiServerName, bouncerName) for per-bouncer rendering.
  const byBouncer = useMemo(() => {
    const map = new Map<string, BouncerMetric[]>();
    for (const m of metrics) {
      const key = `${m.lapiServerName}::${m.bouncerName}`;
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  }, [metrics]);

  const servers = useMemo(() => {
    const set = new Set<string>();
    for (const b of bouncers) set.add(b.lapiServerName);
    for (const m of metrics) set.add(m.lapiServerName);
    return Array.from(set).sort();
  }, [bouncers, metrics]);

  // Pre-compute an activity score per bouncer key so we don't re-derive it
  // inside the sort comparator (O(n) build, O(1) lookup during sort).
  // Skip registration-only rows (metricsJson === '[]') — they carry all-zero
  // counters with a fresh `now` timestamp, which would otherwise mask the
  // real activity of bouncers that mix remediation + log_processor kinds
  // (the registration log_processor row is always newer than the real
  // remediation snapshot and would win `rows[0]`).
  const activityScores = useMemo(() => {
    const scores = new Map<string, number>();
    for (const [key, rows] of byBouncer) {
      const realRows = rows.filter((r) => r.metricsJson !== '[]');
      const latest = realRows[0] ?? rows[0]; // API returns newest-first
      scores.set(key, (latest?.processedItems ?? 0) + (latest?.droppedItems ?? 0));
    }
    return scores;
  }, [byBouncer]);

  const visibleBouncers = useMemo(() => {
    return bouncers
      .filter((b) => !serverFilter || b.lapiServerName === serverFilter)
      .sort((a, b) => {
        const keyA = `${a.lapiServerName}::${a.bouncerName}`;
        const keyB = `${b.lapiServerName}::${b.bouncerName}`;
        const scoreA = activityScores.get(keyA) ?? 0;
        const scoreB = activityScores.get(keyB) ?? 0;
        if (scoreB !== scoreA) return scoreB - scoreA; // higher score first
        return a.bouncerName.localeCompare(b.bouncerName); // alpha tiebreaker
      });
  }, [bouncers, serverFilter, activityScores]);

  // `active_decisions` is a LAPI-global gauge: every bouncer reports the same
  // count (the number of decisions currently held by the LAPI it queries).
  // Summing across bouncers would multiply it by N — take the max instead so
  // the summary card shows the actual LAPI-wide count.
  const totalActive = useMemo(
    () =>
      Array.from(byBouncer.values()).reduce((max, rows) => {
        const latest = rows[0]; // API returns newest-first
        return Math.max(max, latest?.activeDecisions ?? 0);
      }, 0),
    [byBouncer]
  );

  return (
    <div className={`space-y-6 ${loading ? 'opacity-70' : ''}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-2xl font-bold">Bouncers</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="server-filter" className="text-sm text-slate-600">
            LAPI server:
          </label>
          <select
            id="server-filter"
            value={serverFilter}
            onChange={(e) => setServerFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
          >
            <option value="">All servers</option>
            {servers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Bouncers</p>
              <p className="text-2xl font-bold mt-1">{visibleBouncers.length}</p>
              <p className="text-xs text-slate-400 mt-1">configured</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50">
              <Shield className="w-5 h-5 text-blue-500" />
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">LAPI servers</p>
              <p className="text-2xl font-bold mt-1">{servers.length}</p>
              <p className="text-xs text-slate-400 mt-1">reporting</p>
            </div>
            <div className="p-2 rounded-lg bg-purple-50">
              <Server className="w-5 h-5 text-purple-500" />
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Active decisions</p>
              <p className="text-2xl font-bold mt-1">{totalActive.toLocaleString()}</p>
              <p className="text-xs text-slate-400 mt-1">latest snapshot</p>
            </div>
            <div className="p-2 rounded-lg bg-red-50">
              <Activity className="w-5 h-5 text-red-500" />
            </div>
          </div>
        </div>
      </div>

      {/* Per-bouncer charts */}
      {visibleBouncers.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No bouncer metrics yet. Make sure <code>bouncer_metrics.enabled</code> is{' '}
          <code>true</code> in the proxy config and that at least one LAPI server has been polled
          successfully.
        </div>
      ) : (
        visibleBouncers.map((b) => {
          const key = `${b.lapiServerName}::${b.bouncerName}`;
          const rows = byBouncer.get(key) ?? [];
          const series = buildSeries(rows);
          return (
            <div key={key} className="space-y-2">
              <div className="flex items-baseline gap-3">
                <h3 className="text-lg font-semibold">{b.bouncerName}</h3>
                <span className="text-xs text-slate-500">
                  {b.lapiServerName}
                  {b.bouncerType ? ` · ${b.bouncerType}` : ''}
                </span>
              </div>
              {/* `active_decisions` is a LAPI-global gauge — same value on
                  every bouncer — so we only show it in the summary card up
                  top. Per-bouncer views focus on the per-bouncer counters. */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <MiniChart
                  data={series.map((p) => p.processed)}
                  title="Processed"
                  colorClass="bg-blue-500"
                />
                <MiniChart
                  data={series.map((p) => p.dropped)}
                  title="Dropped"
                  colorClass="bg-amber-500"
                />
                <MiniChart
                  data={series.map((p) => p.bytes)}
                  title="Bytes"
                  colorClass="bg-emerald-500"
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
