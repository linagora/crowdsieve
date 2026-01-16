'use client';

import { MapPin, Clock, AlertTriangle, Filter, Send } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { StoredAlert } from '@/lib/types';
import { clsx } from 'clsx';

interface AlertCardProps {
  alert: StoredAlert;
  onClick?: () => void;
}

export function AlertCard({ alert, onClick }: AlertCardProps) {
  const country = alert.geoCountryName || alert.geoCountryCode || alert.sourceCn || 'Unknown';

  return (
    <div
      className={clsx(
        'card p-4 hover:shadow-md transition-shadow cursor-pointer border-l-4',
        alert.filtered ? 'border-l-yellow-500' : 'border-l-green-500'
      )}
      onClick={onClick}
    >
      <div className="flex justify-between items-start">
        <div className="flex-1">
          {/* Scenario Badge */}
          <span className="badge badge-scenario mb-2">{alert.scenario}</span>

          {/* Source IP */}
          <div className="font-mono text-sm text-slate-700">
            {alert.sourceIp || alert.sourceValue}
          </div>

          {/* Message */}
          {alert.message && (
            <p className="text-sm text-slate-500 mt-1 line-clamp-2">{alert.message}</p>
          )}

          {/* Metadata Row */}
          <div className="flex flex-wrap gap-4 mt-3 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {country}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDistanceToNow(new Date(alert.receivedAt), { addSuffix: true })}
            </span>
            {alert.eventsCount && (
              <span className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {alert.eventsCount} events
              </span>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="flex flex-col items-end gap-2">
          {alert.filtered && (
            <span className="badge bg-yellow-100 text-yellow-800">
              <Filter className="w-3 h-3 mr-1" />
              Filtered
            </span>
          )}
          {alert.forwardedToCapi && (
            <span className="badge bg-green-100 text-green-800">
              <Send className="w-3 h-3 mr-1" />
              Forwarded
            </span>
          )}
          {alert.hasDecisions && <span className="badge badge-ban">Has Decision</span>}
        </div>
      </div>
    </div>
  );
}
