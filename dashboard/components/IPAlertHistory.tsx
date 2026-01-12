'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { History, Loader2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StoredAlert } from '@/lib/types';

const PAGE_SIZE = 5;

interface IPAlertHistoryProps {
  ip: string;
  currentAlertId: number;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  return date.toLocaleDateString();
}

export function IPAlertHistory({ ip, currentAlertId }: IPAlertHistoryProps) {
  const [alerts, setAlerts] = useState<StoredAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);

  const fetchAlerts = useCallback(
    async (currentOffset: number, append: boolean = false) => {
      try {
        if (append) {
          setLoadingMore(true);
        } else {
          setLoading(true);
        }
        setError(null);

        // Fetch one extra to check if there are more
        const res = await fetch(
          `/api/alerts?ip=${encodeURIComponent(ip)}&limit=${PAGE_SIZE + 1}&offset=${currentOffset}`
        );

        if (!res.ok) {
          throw new Error('Failed to fetch alerts');
        }

        const data: StoredAlert[] = await res.json();

        // Filter out current alert
        const filteredData = data.filter((a) => a.id !== currentAlertId);

        // Check if there are more results
        const hasMoreResults = filteredData.length > PAGE_SIZE;
        setHasMore(hasMoreResults);

        // Take only PAGE_SIZE items
        const pageData = filteredData.slice(0, PAGE_SIZE);

        if (append) {
          setAlerts((prev) => [...prev, ...pageData]);
        } else {
          setAlerts(pageData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [ip, currentAlertId]
  );

  useEffect(() => {
    if (!ip) {
      setLoading(false);
      return;
    }
    fetchAlerts(0);
  }, [ip, fetchAlerts]);

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    fetchAlerts(newOffset, true);
  };

  if (loading) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <History className="w-5 h-5" />
          Alert History
        </h2>
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading alert history...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <History className="w-5 h-5" />
          Alert History
        </h2>
        <p className="text-slate-500 text-sm">Unable to fetch alert history</p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <History className="w-5 h-5" />
        Alert History for{' '}
        <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-base">{ip}</span>
      </h2>

      {alerts.length === 0 ? (
        <p className="text-slate-500 text-sm">No other alerts from this IP</p>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <Link
              key={alert.id}
              href={`/alerts/${alert.id}`}
              className="block p-3 rounded-lg border border-slate-200 hover:border-crowdsec-primary hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="font-mono text-sm truncate">{alert.scenario}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  {alert.filtered && (
                    <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                      Filtered
                    </span>
                  )}
                  {alert.forwardedToCapi && (
                    <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">
                      Fwd
                    </span>
                  )}
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {formatRelativeTime(alert.receivedAt)}
                  </span>
                </div>
              </div>
            </Link>
          ))}

          {hasMore && (
            <div className="pt-2">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Loading...
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4 mr-2" />
                    Load more
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
