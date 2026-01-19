'use client';

import { useState } from 'react';
import {
  Activity,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { AnalyzersData, AnalyzerStatus } from '@/app/analyzers/page';

interface AnalyzersContentProps {
  data: AnalyzersData;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  }
  return `${minutes}m`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle future dates (clock skew)
  if (diffMs < 0) {
    return 'just now';
  }

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function AnalyzerCard({
  analyzer,
  onTrigger,
  triggering,
}: {
  analyzer: AnalyzerStatus;
  onTrigger: (id: string) => void;
  triggering: boolean;
}) {
  const lastRun = analyzer.lastRun;
  const isSuccess = lastRun?.status === 'success';
  const isError = lastRun?.status === 'error';

  return (
    <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-crowdsec-primary" />
          <h3 className="font-semibold text-gray-900">{analyzer.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          {analyzer.enabled ? (
            <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded-full">
              Active
            </span>
          ) : (
            <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full">
              Disabled
            </span>
          )}
        </div>
      </div>

      <div className="text-sm text-gray-600 mb-3">
        <div className="flex items-center gap-1">
          <Clock className="w-4 h-4" />
          <span>Interval: {formatDuration(analyzer.intervalMs)}</span>
        </div>
      </div>

      {lastRun ? (
        <div className="border-t pt-3 mt-3">
          <div className="flex items-center gap-2 mb-2">
            {isSuccess ? (
              <CheckCircle className="w-4 h-4 text-green-600" />
            ) : isError ? (
              <XCircle className="w-4 h-4 text-red-600" />
            ) : (
              <RefreshCw className="w-4 h-4 text-blue-600 animate-spin" />
            )}
            <span className={`text-sm ${isError ? 'text-red-600' : 'text-gray-700'}`}>
              Last run: {timeAgo(lastRun.completedAt)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-gray-50 rounded p-2">
              <div className="text-lg font-bold text-gray-900">{lastRun.logsFetched}</div>
              <div className="text-xs text-gray-500">Logs</div>
            </div>
            <div className="bg-gray-50 rounded p-2">
              <div className="text-lg font-bold text-orange-600">{lastRun.alertsGenerated}</div>
              <div className="text-xs text-gray-500">Alerts</div>
            </div>
            <div className="bg-gray-50 rounded p-2">
              <div className="text-lg font-bold text-crowdsec-primary">
                {lastRun.decisionsPushed}
              </div>
              <div className="text-xs text-gray-500">Pushed</div>
            </div>
          </div>

          {lastRun.errorMessage && (
            <div className="mt-2 p-2 bg-red-50 rounded text-sm text-red-700">
              {lastRun.errorMessage}
            </div>
          )}
        </div>
      ) : (
        <div className="border-t pt-3 mt-3 text-sm text-gray-500 italic">
          No runs yet
        </div>
      )}

      {analyzer.nextRun && (
        <div className="mt-3 text-xs text-gray-500">
          Next run: {formatDate(analyzer.nextRun)}
        </div>
      )}

      <button
        onClick={() => onTrigger(analyzer.id)}
        disabled={triggering}
        className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 bg-crowdsec-primary text-white rounded hover:bg-crowdsec-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {triggering ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin" />
            Running...
          </>
        ) : (
          <>
            <Play className="w-4 h-4" />
            Run Now
          </>
        )}
      </button>
    </div>
  );
}

export function AnalyzersContent({ data }: AnalyzersContentProps) {
  const [analyzers, setAnalyzers] = useState(data.analyzers);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const handleTrigger = async (id: string) => {
    setTriggeringId(id);
    try {
      const res = await fetch(`/api/analyzers/${id}/run`, {
        method: 'POST',
      });

      if (res.ok) {
        const result = await res.json();
        // Update the analyzer with the new run result
        setAnalyzers((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  lastRun: result.result,
                }
              : a
          )
        );
      }
    } finally {
      setTriggeringId(null);
    }
  };

  if (!data.enabled) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Analyzer Engine Disabled
          </h2>
          <p className="text-gray-600">
            The analyzer engine is not enabled. Add the following to your{' '}
            <code className="bg-gray-100 px-2 py-1 rounded">config/filters.yaml</code>:
          </p>
          <pre className="mt-4 bg-gray-800 text-green-400 p-4 rounded text-left text-sm overflow-x-auto">
{`analyzers:
  enabled: true
  config_dir: "./config/analyzers.d"
  sources:
    grafana-prod:
      type: "loki"
      grafana_url: "\${GRAFANA_URL}"
      token: "\${GRAFANA_TOKEN}"
      datasource_uid: "your-loki-uid"`}
          </pre>
        </div>
      </div>
    );
  }

  if (analyzers.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Analyzers</h1>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <Activity className="w-12 h-12 text-blue-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            No Analyzers Configured
          </h2>
          <p className="text-gray-600">
            Create analyzer configuration files in{' '}
            <code className="bg-gray-100 px-2 py-1 rounded">config/analyzers.d/</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Analyzers</h1>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <CheckCircle className="w-4 h-4 text-green-600" />
          <span>{analyzers.filter((a) => a.enabled).length} active</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {analyzers.map((analyzer) => (
          <AnalyzerCard
            key={analyzer.id}
            analyzer={analyzer}
            onTrigger={handleTrigger}
            triggering={triggeringId === analyzer.id}
          />
        ))}
      </div>
    </div>
  );
}
