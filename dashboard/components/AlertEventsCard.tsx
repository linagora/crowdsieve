'use client';

import { useState } from 'react';
import type { AlertDetailEvent } from '@/lib/types';
import { EVENTS_COLLAPSED_COUNT } from '@/lib/alertDetail';
import { LocalDateTime } from '@/components/LocalDateTime';

interface AlertEventsCardProps {
  events: AlertDetailEvent[];
  /** Number of events of the alert (may exceed `events.length`). */
  total: number;
}

/**
 * Events that triggered an alert. Meta keys and values are attacker-controlled
 * (they come from parsed log lines): they are only ever rendered as React
 * text, never as HTML.
 */
export function AlertEventsCard({ events, total }: AlertEventsCardProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? events : events.slice(0, EVENTS_COLLAPSED_COUNT);

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4">Events ({total})</h2>
      {events.length === 0 ? (
        <p className="text-slate-500 text-sm">No events stored for this alert</p>
      ) : (
        <>
          <ul className="space-y-3">
            {visible.map((event, index) => (
              <li key={index} className="text-sm">
                <div className="text-slate-500 text-xs mb-1">
                  <LocalDateTime value={event.timestamp} fallback="No timestamp" />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {event.meta.length === 0 && <span className="text-slate-400">No meta</span>}
                  {event.meta.map((m, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded font-mono text-xs break-all"
                    >
                      {m.key}: {m.value}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {!expanded && events.length > EVENTS_COLLAPSED_COUNT && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-4 text-sm text-crowdsec-primary hover:underline"
            >
              Show all {total} events
            </button>
          )}
          {total > events.length && (
            <p className="mt-3 text-xs text-slate-500">
              Showing {events.length} of {total} events
            </p>
          )}
        </>
      )}
    </div>
  );
}
