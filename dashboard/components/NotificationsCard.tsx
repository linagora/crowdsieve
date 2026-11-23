'use client';

import { useState } from 'react';
import { Bell, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/hooks/useNotifications';
import {
  EVENT_LABELS,
  TARGET_TYPE_LABELS,
  intervalLabel,
  lastDeliveryLabel,
  matchSummary,
  retryingLabel,
  testResultLabel,
  type DeliveryTone,
  type NotificationTargetStatus,
  type NotificationTestResult,
} from '@/lib/notifications';

const REFRESH_INTERVAL_MS = 30_000;

const toneClasses: Record<DeliveryTone, string> = {
  green: 'text-green-700',
  red: 'text-red-700',
  slate: 'text-slate-500',
};

interface TestState {
  pending: boolean;
  result: NotificationTestResult | null;
}

function TargetRow({
  target,
  now,
  canSendTest,
  test,
  onTest,
}: {
  target: NotificationTargetStatus;
  now: number;
  canSendTest: boolean;
  test: TestState | undefined;
  onTest: (name: string) => void;
}) {
  const delivery = lastDeliveryLabel(target, now);
  const retrying = retryingLabel(target);
  const match = matchSummary(target.match);

  return (
    <li className="py-3 space-y-1" data-testid={`notification-target-${target.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{target.name}</span>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
            {TARGET_TYPE_LABELS[target.type]}
          </span>
          <span className="text-xs text-slate-500 truncate">{target.host}</span>
        </div>
        {canSendTest && (
          <div className="flex items-center gap-2">
            {test?.result && (
              <span
                role="status"
                className={`text-sm ${test.result.ok ? 'text-green-700' : 'text-red-700'}`}
              >
                {testResultLabel(test.result)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTest(target.name)}
              disabled={test?.pending}
              className="gap-1"
            >
              {test?.pending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              Send test
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {target.events.map((event) => (
          <span
            key={event}
            className="text-xs px-2 py-0.5 rounded-full bg-crowdsec-primary/10 text-crowdsec-primary"
          >
            {EVENT_LABELS[event]}
          </span>
        ))}
        <span className="text-xs text-slate-500 px-1 py-0.5">{intervalLabel(target)}</span>
      </div>
      {match && <p className="text-xs text-slate-500 break-words">{match}</p>}
      <p className={`text-sm break-words ${toneClasses[delivery.tone]}`}>{delivery.text}</p>
      {retrying && <p className="text-sm text-amber-700 break-words">{retrying}</p>}
      {target.dropped > 0 && (
        <p className="text-sm text-amber-700">
          {target.dropped.toLocaleString()} message{target.dropped > 1 ? 's' : ''} dropped (queue
          full)
        </p>
      )}
    </li>
  );
}

/**
 * "Notifications" card of the status page: the configured targets, their
 * last delivery and a "Send test" button. `canSendTest` hides the button
 * (e.g. for read-only users).
 */
export function NotificationsCard({
  now,
  canSendTest = true,
}: {
  now: number;
  canSendTest?: boolean;
}) {
  const { notifications, error, refresh } = useNotifications(REFRESH_INTERVAL_MS);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  async function sendTest(name: string) {
    setTests((prev) => ({ ...prev, [name]: { pending: true, result: null } }));
    let result: NotificationTestResult;
    try {
      const res = await fetch(`/api/notifications/${encodeURIComponent(name)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      const data = (await res.json().catch(() => ({}))) as Partial<NotificationTestResult> & {
        error?: string;
      };
      result =
        res.ok && typeof data.ok === 'boolean'
          ? { ok: data.ok, message: data.message ?? '' }
          : { ok: false, message: data.error ?? `HTTP ${res.status}` };
    } catch {
      result = { ok: false, message: 'Network error' };
    }
    setTests((prev) => ({ ...prev, [name]: { pending: false, result } }));
    refresh();
  }

  return (
    <div className="card p-4 space-y-2" data-testid="notifications-card">
      <h3 className="font-semibold flex items-center gap-2">
        <Bell className="w-4 h-4 text-slate-500" /> Notifications
      </h3>
      {!notifications ? (
        <p className="text-sm text-slate-500">
          {error ? 'Unable to load the notification targets.' : 'Loading…'}
        </p>
      ) : notifications.targets.length === 0 ? (
        <p className="text-sm text-slate-500">
          No notification target configured (<code>notifications</code> section of the proxy
          configuration).
        </p>
      ) : (
        <>
          {!notifications.dashboardUrl && (
            <p className="text-sm text-amber-700">
              <code>notifications.dashboard_url</code> is not set: messages carry no link to the
              dashboard.
            </p>
          )}
          <ul className="divide-y divide-slate-100">
            {notifications.targets.map((target) => (
              <TargetRow
                key={target.name}
                target={target}
                now={now}
                canSendTest={canSendTest}
                test={tests[target.name]}
                onTest={(name) => void sendTest(name)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
