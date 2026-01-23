'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, Loader2, Shield, ShieldAlert, Globe, Server, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DecisionSearchResponse, Decision } from '@/lib/types';

interface DecisionCardProps {
  decision: Decision;
  server?: string;
  onDelete?: (decisionId: number, server: string) => Promise<void>;
  canDelete?: boolean;
}

function DecisionCard({ decision, server, onDelete, canDelete }: DecisionCardProps) {
  const isExpired = decision.until && new Date(decision.until) < new Date();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!onDelete || !server || !decision.id) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete this decision?\n\nType: ${decision.type}\nScenario: ${decision.scenario}\nValue: ${decision.value}`
    );
    if (!confirmed) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(decision.id, server);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={`p-3 rounded-lg border ${isExpired ? 'bg-slate-50 border-slate-200' : 'bg-red-50 border-red-200'}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className={`w-4 h-4 ${isExpired ? 'text-slate-400' : 'text-red-600'}`} />
          <span className="font-medium">{decision.type}</span>
          <span className="text-slate-500">-</span>
          <span className="font-mono text-sm">{decision.scenario}</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-1 rounded ${isExpired ? 'bg-slate-200 text-slate-600' : 'bg-red-100 text-red-700'}`}
          >
            {decision.origin}
          </span>
          {canDelete && decision.id && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
              title="Delete decision"
            >
              {deleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 text-sm text-slate-600 space-y-1">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 bg-slate-100 rounded text-xs font-medium">
            {decision.scope}
          </span>
          <span className="font-mono">{decision.value}</span>
        </div>
        <div className="flex gap-4">
          <span>Duration: {decision.duration}</span>
          {decision.until && (
            <span>
              {isExpired ? 'Expired' : 'Until'}: {new Date(decision.until).toLocaleString()}
            </span>
          )}
        </div>
      </div>
      {deleteError && <p className="mt-2 text-sm text-red-600">{deleteError}</p>}
    </div>
  );
}

function DecisionSearchContent() {
  const searchParams = useSearchParams();
  const initialIp = searchParams.get('ip') || '';

  const [ip, setIp] = useState(initialIp);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DecisionSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(
    async (searchIp?: string) => {
      const ipToSearch = searchIp || ip;
      if (!ipToSearch.trim()) return;

      setSearching(true);
      setError(null);
      setResults(null);

      try {
        const res = await fetch(`/api/decisions?ip=${encodeURIComponent(ipToSearch.trim())}`);
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || 'Failed to search decisions');
        } else {
          setResults(data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setSearching(false);
        setHasSearched(true);
      }
    },
    [ip]
  );

  const handleDeleteDecision = useCallback(
    async (decisionId: number, server: string) => {
      const res = await fetch(`/api/decisions/${decisionId}?server=${encodeURIComponent(server)}`, {
        method: 'DELETE',
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete decision');
      }

      // Refresh results after successful delete
      if (results?.ip) {
        handleSearch(results.ip);
      }
    },
    [results?.ip, handleSearch]
  );

  // Auto-search if IP is provided in URL
  useEffect(() => {
    if (initialIp) {
      setIp(initialIp);
      handleSearch(initialIp);
    }
  }, [initialIp, handleSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearch();
  };

  const totalDecisions = results
    ? results.results.reduce((acc, r) => acc + r.decisions.length, 0) + results.shared.length
    : 0;

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <h1 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <Shield className="w-6 h-6" />
          Decision Search
        </h1>

        <form onSubmit={handleSubmit} className="flex gap-4">
          <input
            type="text"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="Enter IP address (e.g., 192.168.1.1)"
            className="flex-1 px-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary font-mono"
          />
          <Button type="submit" disabled={searching || !ip.trim()}>
            {searching ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Search
              </>
            )}
          </Button>
        </form>
      </div>

      {error && (
        <div className="card p-6 bg-red-50 border-red-200">
          <p className="text-red-700">{error}</p>
        </div>
      )}

      {results && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="card p-4">
            <p className="text-lg">
              Found <strong>{totalDecisions}</strong> decision{totalDecisions !== 1 ? 's' : ''} for{' '}
              <span className="font-mono bg-slate-100 px-2 py-1 rounded">{results.ip}</span>
            </p>
          </div>

          {/* Shared decisions (from CAPI/lists) - cannot be deleted */}
          {results.shared.length > 0 && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Globe className="w-5 h-5" />
                Shared Decisions (all servers)
              </h2>
              <p className="text-sm text-slate-500 mb-4">
                These decisions come from CrowdSec central lists and apply to all your servers.
              </p>
              <div className="space-y-3">
                {results.shared.map((decision, idx) => (
                  <DecisionCard key={`shared-${idx}`} decision={decision} canDelete={false} />
                ))}
              </div>
            </div>
          )}

          {/* Per-server decisions - can be deleted */}
          {results.results.map((serverResult) => (
            <div key={serverResult.server} className="card p-6">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Server className="w-5 h-5" />
                {serverResult.server}
              </h2>

              {serverResult.error ? (
                <p className="text-red-600 text-sm">{serverResult.error}</p>
              ) : serverResult.decisions.length === 0 ? (
                <p className="text-slate-500 text-sm">No local decisions on this server</p>
              ) : (
                <div className="space-y-3">
                  {serverResult.decisions.map((decision, idx) => (
                    <DecisionCard
                      key={`${serverResult.server}-${idx}`}
                      decision={decision}
                      server={serverResult.server}
                      onDelete={handleDeleteDecision}
                      canDelete={true}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {hasSearched && !results && !error && !searching && (
        <div className="card p-6 text-center text-slate-500">No results found</div>
      )}
    </div>
  );
}

export default function DecisionsPage() {
  return (
    <Suspense
      fallback={
        <div className="card p-6">
          <div className="flex items-center justify-center py-8 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading...
          </div>
        </div>
      }
    >
      <DecisionSearchContent />
    </Suspense>
  );
}
