'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shield, Activity, Server, Ban } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import type { BouncerMetric, BouncerName } from '@/lib/types';

interface BouncersContentProps {
  initialBouncers: BouncerName[];
  initialMetrics: BouncerMetric[];
  initialBlockedRequests?: number;
}

interface SeriesPoint {
  collectedAt: number;
  active: number;
  processed: number;
  dropped: number;
  bytes: number;
}

function buildSeries(rows: BouncerMetric[]): SeriesPoint[] {
  // Drop registration-only rows (metricsJson === '[]'): they're injected by
  // the parser at "now" timestamp for bouncers that never push real metrics
  // (or for hybrid bouncers where the log_processor side has nothing to
  // report). They carry all-zero counters and would pollute the chart with
  // misleading zero bars AND make the legend's "latest value" indicator
  // always read 0/0 since the registration row tends to be newest.
  // Rows arrive newest-first from the API; flip to oldest-first for the chart
  // so time flows left-to-right.
  const sorted = rows
    .filter((r) => r.metricsJson !== '[]')
    .sort((a, b) => a.collectedAt - b.collectedAt);
  return sorted.map((r) => ({
    collectedAt: r.collectedAt,
    active: r.activeDecisions ?? 0,
    processed: r.processedItems ?? 0,
    dropped: r.droppedItems ?? 0,
    bytes: r.bytesProcessed ?? 0,
  }));
}

/**
 * Compact timestamp formatter for chart axis labels. "DD/MM HH:mm" so a
 * span across days stays readable in a small label.
 */
function formatChartTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface DualChartProps {
  series: SeriesPoint[];
}

/**
 * Dual-series mini-chart: paired bars per timestamp (processed in blue,
 * dropped in amber). Each series is normalized to ITS OWN max so they share
 * the visual height even though their absolute values can differ by orders
 * of magnitude (typical: millions of processed vs handful of dropped).
 */
function DualChart({ series }: DualChartProps) {
  if (series.length === 0) {
    return <div className="text-center text-slate-400 py-6 text-sm">No data</div>;
  }
  const maxProcessed = Math.max(...series.map((p) => p.processed), 1);
  const maxDropped = Math.max(...series.map((p) => p.dropped), 1);
  // Show totals over the visible window. The last snapshot alone is misleading
  // for sparse-activity bouncers whose most recent row may be a quiet one
  // even when the chart shows real spikes.
  const sumProcessed = series.reduce((s, p) => s + p.processed, 0);
  const sumDropped = series.reduce((s, p) => s + p.dropped, 0);
  const startTs = series[0].collectedAt;
  const endTs = series[series.length - 1].collectedAt;
  return (
    <>
      <div className="flex items-end gap-px h-16">
        {series.map((p, i) => (
          <div key={i} className="flex-1 min-w-[3px] h-full flex items-end gap-px">
            <div
              className="flex-1 bg-blue-500 rounded-t"
              style={{ height: `${Math.max((p.processed / maxProcessed) * 100, 2)}%` }}
              title={`${formatChartTime(p.collectedAt)} · processed: ${p.processed.toLocaleString()}`}
            />
            <div
              className="flex-1 bg-amber-500 rounded-t"
              style={{ height: `${Math.max((p.dropped / maxDropped) * 100, 2)}%` }}
              title={`${formatChartTime(p.collectedAt)} · dropped: ${p.dropped.toLocaleString()}`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center text-xs mt-2 gap-2">
        <span className="flex items-center gap-1 text-slate-700">
          <span className="inline-block w-2 h-2 bg-blue-500 rounded-sm" />
          <span className="font-medium">{sumProcessed.toLocaleString()}</span>
          <span className="text-slate-400">proc</span>
        </span>
        <span className="flex items-center gap-1 text-slate-700">
          <span className="inline-block w-2 h-2 bg-amber-500 rounded-sm" />
          <span className="font-medium">{sumDropped.toLocaleString()}</span>
          <span className="text-slate-400">drop</span>
        </span>
      </div>
      <div className="flex justify-between text-[10px] text-slate-400 mt-1">
        <span>{formatChartTime(startTs)}</span>
        <span>{formatChartTime(endTs)}</span>
      </div>
    </>
  );
}

export function BouncersContent({
  initialBouncers,
  initialMetrics,
  initialBlockedRequests = 0,
}: BouncersContentProps) {
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
  // counters and would dilute the score.
  // Score = SUM of droppedItems over the visible window. Using LATEST instead
  // of SUM made bouncers like `llng` (sparse drops: occasional spikes of
  // 24-34 then quiet for hours) drop to 0 because their most recent snapshot
  // was a quiet one, even though the chart visibly showed real activity.
  // SUM matches what the bars convey and ranks bouncers by total impact
  // over the period.
  const activityScores = useMemo(() => {
    const scores = new Map<string, number>();
    for (const [key, rows] of byBouncer) {
      const sumDropped = rows.reduce(
        (s, r) => s + (r.metricsJson === '[]' ? 0 : r.droppedItems ?? 0),
        0
      );
      scores.set(key, sumDropped);
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Blocked Requests</p>
              <p className="text-2xl font-bold mt-1">
                {initialBlockedRequests.toLocaleString()}
              </p>
              <p className="text-xs text-slate-400 mt-1">retention window</p>
            </div>
            <div className="p-2 rounded-lg bg-red-50">
              <Ban className="w-5 h-5 text-red-500" />
            </div>
          </div>
        </div>
      </div>

      {/* Per-bouncer compact cards in a responsive grid (3-4 per row).
          Each card shows a dual-series chart (processed/dropped, each
          with its own scale) so we can fit many bouncers on screen at
          once. `active_decisions` is a LAPI-global gauge so it only
          appears in the summary card above. `bytesProcessed` is dropped
          for now — CrowdSec encodes byte counts as a unit modifier on
          `processed`, not as a separate `bytes` metric, so the parser
          never populates it. */}
      {visibleBouncers.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No bouncer metrics yet. Make sure <code>bouncer_metrics.enabled</code> is{' '}
          <code>true</code> in the proxy config and that at least one LAPI server has been polled
          successfully.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleBouncers.map((b) => {
            const key = `${b.lapiServerName}::${b.bouncerName}`;
            const rows = byBouncer.get(key) ?? [];
            const series = buildSeries(rows);
            return (
              <div key={key} className="card p-3 space-y-1">
                <div className="flex flex-col gap-0.5">
                  <h3
                    className="text-sm font-semibold truncate"
                    title={`${b.bouncerName}${b.bouncerType ? ` · ${b.bouncerType}` : ''}`}
                  >
                    {b.bouncerName}
                  </h3>
                  <span className="text-[10px] text-slate-500 truncate" title={b.lapiServerName}>
                    {b.lapiServerName}
                    {b.bouncerType ? ` · ${b.bouncerType}` : ''}
                  </span>
                </div>
                <DualChart series={series} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
