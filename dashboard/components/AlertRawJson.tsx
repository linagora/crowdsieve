'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { prettyPrintJson } from '@/lib/alertDetail';

interface AlertRawJsonProps {
  alertId: number;
}

/**
 * Collapsible view of the JSON payload stored for an alert, loaded on first
 * open. It is shown in a `<pre>` as React text (never as HTML).
 */
export function AlertRawJson({ alertId }: AlertRawJsonProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/alerts/${alertId}/raw`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error || 'Failed to load raw data');
        return;
      }
      const data = (await res.json()) as { rawJson?: string };
      setText(prettyPrintJson(data.rawJson ?? ''));
    } catch {
      setError('Failed to load raw data');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (text === null) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    setCopyState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Raw JSON</h2>
        <div className="flex items-center gap-3">
          {open && text !== null && (
            <button
              type="button"
              onClick={copy}
              className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50"
            >
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="text-sm text-crowdsec-primary hover:underline"
          >
            {open ? 'Hide raw JSON' : 'Show raw JSON'}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-4">
          {loading && <p className="text-sm text-slate-500">Loading...</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {text !== null && (
            <pre className="p-3 bg-slate-50 border border-slate-200 rounded text-xs font-mono overflow-auto max-h-96 whitespace-pre">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
