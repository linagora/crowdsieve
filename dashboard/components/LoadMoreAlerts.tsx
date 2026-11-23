'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LoadMoreAlertsProps {
  hasMore: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
}

/** "Load more alerts" button shown at the end of an alert list. */
export function LoadMoreAlerts({ hasMore, isLoadingMore, error, onLoadMore }: LoadMoreAlertsProps) {
  if (!hasMore) return null;
  return (
    <div className="flex flex-col items-center gap-1 pt-2">
      <Button variant="secondary" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
        {isLoadingMore ? (
          <>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            Loading…
          </>
        ) : (
          'Load more alerts'
        )}
      </Button>
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
