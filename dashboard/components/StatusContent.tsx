'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Server, Send } from 'lucide-react';
import { useStatus } from '@/components/hooks/useStatus';
import { formatAgo } from '@/lib/relativeTime';
import { summaryLabel, type CapiStatus, type LapiStatus } from '@/lib/status';

const REFRESH_INTERVAL_MS = 30_000;

type Tone = 'green' | 'red' | 'slate' | 'amber';

const toneClasses: Record<Tone, string> = {
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  slate: 'bg-slate-100 text-slate-700',
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}

function Absolute({ ts, now }: { ts: number; now: number }) {
  return (
    <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {formatAgo(ts, now)}
    </time>
  );
}

function CapiCard({ capi, now }: { capi: CapiStatus; now: number }) {
  const badge =
    capi.state === 'disabled' ? (
      <Badge tone="slate">Disabled (FORWARD_ENABLED=false)</Badge>
    ) : capi.state === 'failing' ? (
      <Badge tone="red">Failing</Badge>
    ) : capi.state === 'ok' ? (
      <Badge tone="green">Enabled</Badge>
    ) : (
      <Badge tone="green">Enabled, nothing sent yet</Badge>
    );
  return (
    <div className="card p-4 space-y-2" data-testid="capi-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold flex items-center gap-2">
          <Send className="w-4 h-4 text-slate-500" /> CAPI forwarding
        </h3>
        {badge}
      </div>
      {capi.enabled && (
        <>
          <p className="text-sm text-slate-600">
            Last successful push:{' '}
            {capi.lastSuccessAt ? <Absolute ts={capi.lastSuccessAt} now={now} /> : 'never'}
          </p>
          <p className="text-sm text-slate-600">
            Sent in 24h: {capi.sent24h.toLocaleString()} · Failed: {capi.failed24h.toLocaleString()}
          </p>
        </>
      )}
      {capi.lastError && (
        <p className="text-sm text-red-700 break-words">
          Last error (<Absolute ts={capi.lastError.at} now={now} />
          ): {capi.lastError.message}
        </p>
      )}
    </div>
  );
}

function LapiCard({ lapi, now }: { lapi: LapiStatus; now: number }) {
  const badge =
    lapi.reachable === null ? (
      <Badge tone="slate">Not checked yet</Badge>
    ) : lapi.reachable ? (
      <Badge tone="green">
        Reachable{lapi.responseTimeMs !== null ? ` · ${lapi.responseTimeMs} ms` : ''}
      </Badge>
    ) : (
      <Badge tone="red">Unreachable{lapi.error ? `: ${lapi.error}` : ''}</Badge>
    );

  let manualBan = 'Manual ban unavailable: no machine credentials';
  if (lapi.manualBanAvailable) manualBan = 'Manual ban available';
  else if (lapi.machineCredentials) manualBan = 'Manual ban unavailable: machine login failed';

  return (
    <div className="card p-4 space-y-2" data-testid={`lapi-card-${lapi.name}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold flex items-center gap-2 min-w-0">
          <Server className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="truncate">{lapi.name}</span>
        </h3>
        <div className="text-right break-words max-w-[60%]">{badge}</div>
      </div>
      <p className="text-xs text-slate-500">
        {lapi.host}
        {lapi.checkedAt ? (
          <>
            {' · '}last checked <Absolute ts={lapi.checkedAt} now={now} />
          </>
        ) : null}
      </p>
      <p className="text-sm text-slate-600">{manualBan}</p>
      <p className="text-sm text-slate-600">
        {lapi.replication.enabled ? (
          lapi.replication.lastError ? (
            <span className="text-red-700">
              Replication: last error <Absolute ts={lapi.replication.lastError.at} now={now} />:{' '}
              {lapi.replication.lastError.message}
            </span>
          ) : (
            'Replication: enabled'
          )
        ) : (
          'Replication: off'
        )}
      </p>
    </div>
  );
}

export function StatusContent() {
  const { status, unauthorized, error } = useStatus(REFRESH_INTERVAL_MS);
  // Relative times are computed on the client only (set after mount).
  const [now, setNow] = useState<number>(0);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  // A fresh answer implies a fresh clock reading.
  const clock = status ? Math.max(now, status.generatedAt) : now;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Status</h2>

      {unauthorized && <div className="card p-6 text-slate-600">You are not signed in.</div>}
      {!unauthorized && !status && (
        <div className="card p-6 text-slate-500">
          {error ? 'Unable to load the status.' : 'Loading…'}
        </div>
      )}

      {status && (
        <>
          <div
            role="status"
            className={`rounded-lg px-4 py-3 flex items-center gap-2 font-medium ${
              status.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
            }`}
          >
            {status.ok ? (
              <CheckCircle2 className="w-5 h-5" />
            ) : (
              <AlertTriangle className="w-5 h-5" />
            )}
            {summaryLabel(status)}
          </div>
          {!status.ok && (
            <ul className="list-disc pl-6 text-sm text-red-800 space-y-1">
              {status.problems.map((p, i) => (
                <li key={i} className="break-words">
                  {p.message}
                </li>
              ))}
            </ul>
          )}

          <CapiCard capi={status.capi} now={clock} />

          <div>
            <h3 className="text-lg font-semibold mb-3">LAPI servers</h3>
            {status.lapis.length === 0 ? (
              <div className="card p-6 text-slate-500">No LAPI server configured.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {status.lapis.map((l) => (
                  <LapiCard key={l.name} lapi={l} now={clock} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
