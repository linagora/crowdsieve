'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StoredAlert } from '@/lib/types';
import { AlertCard } from './AlertCard';

interface AlertsTableProps {
  initialAlerts: StoredAlert[];
}

export function AlertsTable({ initialAlerts }: AlertsTableProps) {
  const [alerts] = useState<StoredAlert[]>(initialAlerts);
  const [filter, setFilter] = useState<'all' | 'filtered' | 'forwarded'>('all');
  const router = useRouter();

  const filteredAlerts = alerts.filter((alert) => {
    if (filter === 'filtered') return alert.filtered;
    if (filter === 'forwarded') return !alert.filtered;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header with filters */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Recent Alerts</h2>
        <div className="flex gap-2">
          {(['all', 'filtered', 'forwarded'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-sm rounded-full transition-colors ${
                filter === f
                  ? 'bg-crowdsec-primary text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Alerts list */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {filteredAlerts.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onClick={() => router.push(`/alerts/${alert.id}`)}
          />
        ))}

        {filteredAlerts.length === 0 && (
          <div className="text-center text-slate-400 py-8">No alerts match the current filter</div>
        )}
      </div>
    </div>
  );
}
