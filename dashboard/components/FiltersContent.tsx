'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { FlaskConical, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import {
  FILTER_PERIODS,
  FILTER_PERIOD_LABELS,
  matchCountLabel,
  modeDescription,
  parseAlertIdInput,
  periodSince,
  ruleAlertsHref,
  sortRules,
  testResultText,
  type FilterMode,
  type FilterPeriod,
  type FilterRuleInfo,
  type FilterRuleStats,
  type FilterRulesResponse,
  type FilterTestResult,
} from '@/lib/filterRules';

interface FiltersContentProps {
  /** null when the proxy did not answer the rule list */
  rules: FilterRulesResponse | null;
  /** Counts for the last 30 days, null when unavailable */
  initialStats: FilterRuleStats | null;
}

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: FilterTestResult }
  | { status: 'error'; message: string };

function TestAlertForm({ mode }: { mode: FilterMode }) {
  const [alertId, setAlertId] = useState('');
  const [state, setState] = useState<TestState>({ status: 'idle' });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const id = parseAlertIdInput(alertId);
    if (id === null) {
      setState({ status: 'error', message: 'Enter a numeric alert ID' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const res = await fetchWithAuth('/api/filters/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: id }),
      });
      if (res.status === 404) {
        setState({ status: 'error', message: 'Alert not found' });
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setState({ status: 'error', message: data?.error || 'Failed to test the alert' });
        return;
      }
      setState({ status: 'done', result: data as FilterTestResult });
    } catch {
      setState({ status: 'error', message: 'Failed to test the alert' });
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <FlaskConical className="w-5 h-5 text-slate-500" />
        Test an alert
      </h3>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
        <div>
          <label
            htmlFor="filter-test-alert-id"
            className="text-xs font-medium text-slate-500 block mb-1"
          >
            Alert ID
          </label>
          <input
            id="filter-test-alert-id"
            type="text"
            inputMode="numeric"
            value={alertId}
            onChange={(e) => setAlertId(e.target.value)}
            placeholder="e.g. 42"
            className="w-40 px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary font-mono"
          />
        </div>
        <Button type="submit" disabled={state.status === 'loading' || !alertId.trim()}>
          {state.status === 'loading' && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          Test
        </Button>
      </form>
      <div aria-live="polite">
        {state.status === 'done' && (
          <p
            className={`text-sm font-medium ${state.result.filtered ? 'text-orange-700' : 'text-green-700'}`}
          >
            {testResultText(state.result, mode)}
          </p>
        )}
        {state.status === 'error' && <p className="text-sm text-red-600">{state.message}</p>}
      </div>
      <p className="text-xs text-slate-400">
        Runs the rules loaded now on the alert as it was received. Nothing is stored or forwarded.
      </p>
    </div>
  );
}

interface RuleCardProps {
  rule: FilterRuleInfo;
  mode: FilterMode;
  period: FilterPeriod;
  stat: FilterRuleStats['byRule'][number] | undefined;
  statsAvailable: boolean;
}

function RuleCard({ rule, mode, period, stat, statsAvailable }: RuleCardProps) {
  return (
    <div className={`card p-4 space-y-3 ${rule.enabled ? '' : 'opacity-75'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold font-mono break-all">{rule.name}</h3>
          {rule.description && <p className="text-sm text-slate-600">{rule.description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {rule.file && <span className="text-xs text-slate-400 font-mono">{rule.file}</span>}
          {rule.enabled ? (
            <span className="badge bg-green-100 text-green-800">Enabled</span>
          ) : (
            <span className="badge bg-slate-100 text-slate-600">Disabled</span>
          )}
        </div>
      </div>
      <pre className="text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre">
        {rule.condition}
      </pre>
      <p className="text-sm text-slate-600">
        {!statsAvailable ? (
          'Counts unavailable'
        ) : stat && stat.count > 0 ? (
          <>
            <Link
              href={ruleAlertsHref(rule.name, mode, period)}
              className="font-medium text-crowdsec-primary hover:underline"
            >
              {matchCountLabel(stat.count, mode)}
            </Link>
            {stat.lastMatchedAt && (
              <>
                {' · '}last match{' '}
                {formatDistanceToNow(new Date(stat.lastMatchedAt), { addSuffix: true })}
              </>
            )}
          </>
        ) : (
          'No match in this period'
        )}
      </p>
    </div>
  );
}

export function FiltersContent({ rules, initialStats }: FiltersContentProps) {
  // The server page loaded the counts of the default period (30 days)
  const [period, setPeriod] = useState<FilterPeriod>('30d');
  const [stats, setStats] = useState<FilterRuleStats | null>(initialStats);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const selectPeriod = async (next: FilterPeriod) => {
    setPeriod(next);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setLoading(true);
    try {
      const since = periodSince(next);
      const qs = since ? `?since=${encodeURIComponent(since.toISOString())}` : '';
      const res = await fetchWithAuth(`/api/filters/stats${qs}`, {
        signal: abortController.signal,
      });
      const data = res.ok ? await res.json() : null;
      if (!abortController.signal.aborted) setStats(data);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setStats(null);
    } finally {
      if (!abortController.signal.aborted) setLoading(false);
    }
  };

  if (!rules) {
    return (
      <div className="card p-6 text-center text-slate-500">
        The filter rules could not be loaded from the proxy.
      </div>
    );
  }

  const statsByName = new Map((stats?.byRule ?? []).map((s) => [s.name, s]));
  const sortedRules = sortRules(rules.rules);

  return (
    <div className={`space-y-6 ${loading ? 'opacity-70' : ''}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Filters</h2>
          <p className="text-sm text-slate-600 mt-1">
            <span className="font-medium">Mode: {rules.mode}</span> — {modeDescription(rules.mode)}
          </p>
        </div>
        <div className="flex gap-2">
          {FILTER_PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => selectPeriod(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-crowdsec-accent text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {FILTER_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <TestAlertForm mode={rules.mode} />

      {stats && (
        <p className="text-sm text-slate-500">
          {stats.filtered.toLocaleString('en-US')} of {stats.total.toLocaleString('en-US')} alerts
          filtered in this period. Alerts stored before rule names were recorded count under no
          rule.
        </p>
      )}

      {sortedRules.length === 0 ? (
        <div className="card p-6 text-center text-slate-500">
          No filter rules are loaded: every alert is{' '}
          {rules.mode === 'block' ? 'forwarded' : 'filtered'}.
        </div>
      ) : (
        <div className="space-y-4">
          {sortedRules.map((rule, index) => (
            <RuleCard
              key={`${index}-${rule.name}`}
              rule={rule}
              mode={rules.mode}
              period={period}
              stat={statsByName.get(rule.name)}
              statsAvailable={stats !== null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
