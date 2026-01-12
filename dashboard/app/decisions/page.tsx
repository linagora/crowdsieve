'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, Loader2, Shield, ShieldAlert, Globe, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DecisionSearchResponse, Decision } from '@/lib/types';

function DecisionCard({ decision }: { decision: Decision }) {
  const isExpired = decision.until && new Date(decision.until) < new Date();

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
        <span
          className={`text-xs px-2 py-1 rounded ${isExpired ? 'bg-slate-200 text-slate-600' : 'bg-red-100 text-red-700'}`}
        >
          {decision.origin}
        </span>
      </div>
      <div className="mt-2 text-sm text-slate-600 flex gap-4">
        <span>Duration: {decision.duration}</span>
        {decision.until && (
          <span>
            {isExpired ? 'Expired' : 'Until'}: {new Date(decision.until).toLocaleString()}
          </span>
        )}
      </div>
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

  const handleSearch = async (searchIp?: string) => {
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
  };

  // Auto-search if IP is provided in URL
  useEffect(() => {
    if (initialIp) {
      setIp(initialIp);
      handleSearch(initialIp);
    }
  }, [initialIp]);

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

          {/* Shared decisions (from CAPI/lists) */}
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
                  <DecisionCard key={`shared-${idx}`} decision={decision} />
                ))}
              </div>
            </div>
          )}

          {/* Per-server decisions */}
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
                    <DecisionCard key={`${serverResult.server}-${idx}`} decision={decision} />
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
