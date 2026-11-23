'use client';

import { useState, useEffect, useMemo } from 'react';
import { Ban, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LapiServer, BanDecisionResponse } from '@/lib/types';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import {
  BAN_CONCURRENCY,
  BAN_TYPES,
  DURATION_UNITS,
  banButtonLabel,
  banTargetsError,
  customDuration,
  parseBanTargets,
  runWithConcurrency,
  summarizeBanAttempts,
  type BanAttempt,
  type BanSummary,
  type BanType,
  type DurationUnit,
} from '@/lib/banForm';

const DEFAULT_DURATION = '4h';
const CUSTOM_DURATION = 'custom';

const DURATION_OPTIONS = [
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: '24 hours', value: '24h' },
  { label: '7 days', value: '168h' },
  { label: '30 days', value: '720h' },
  { label: 'Custom…', value: CUSTOM_DURATION },
];

const ALL_SERVERS = '__all__';

const INPUT_CLASS =
  'w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary';

interface BanIPFormProps {
  initialIp?: string;
}

/**
 * Manual Ban card. Self-contained (it loads the LAPI servers itself), so a
 * page can hide it entirely, e.g. for read-only users, by not rendering it.
 */
export function BanIPForm({ initialIp = '' }: BanIPFormProps) {
  const [servers, setServers] = useState<LapiServer[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [selectedServer, setSelectedServer] = useState('');
  const [targetsText, setTargetsText] = useState(initialIp);
  const [type, setType] = useState<BanType>('ban');
  const [durationChoice, setDurationChoice] = useState(DEFAULT_DURATION);
  const [customAmount, setCustomAmount] = useState('');
  const [customUnit, setCustomUnit] = useState<DurationUnit>('hours');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BanSummary | null>(null);

  useEffect(() => {
    const fetchServers = async () => {
      try {
        const res = await fetchWithAuth('/api/lapi-servers');
        if (res.ok) {
          const data: LapiServer[] = await res.json();
          setServers(data);
          // Only consider servers with machine credentials for default selection
          const banCapable = data.filter((s) => s.canBan);
          if (banCapable.length > 1) {
            // Default to "all servers" when multiple servers can ban
            setSelectedServer(ALL_SERVERS);
          } else if (banCapable.length === 1) {
            setSelectedServer(banCapable[0].name);
          }
        }
      } catch (err) {
        console.error('Failed to fetch LAPI servers:', err);
      } finally {
        setLoadingServers(false);
      }
    };

    fetchServers();
  }, []);

  useEffect(() => {
    setTargetsText(initialIp);
  }, [initialIp]);

  const targets = useMemo(() => parseBanTargets(targetsText), [targetsText]);
  const targetsError = banTargetsError(targets);

  const isCustomDuration = durationChoice === CUSTOM_DURATION;
  const customResult = isCustomDuration ? customDuration(customAmount, customUnit) : null;
  const duration = customResult
    ? 'duration' in customResult
      ? customResult.duration
      : null
    : durationChoice;
  // An empty custom amount only disables the button; anything else explains why.
  const durationError =
    customResult && 'error' in customResult && customAmount.trim() !== ''
      ? customResult.error
      : null;

  // Filter servers that can ban (have machine credentials)
  const serversWithBan = servers.filter((s) => s.canBan);
  const targetServers =
    selectedServer === ALL_SERVERS
      ? serversWithBan.map((s) => s.name)
      : selectedServer
        ? [selectedServer]
        : [];
  const requestCount = targets.valid.length * targetServers.length;

  const banOne = async (target: string, serverName: string): Promise<BanAttempt> => {
    try {
      const res = await fetchWithAuth('/api/decisions/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: serverName,
          ip: target,
          duration,
          type,
          reason: reason.trim(),
        }),
      });

      const data: BanDecisionResponse = await res.json();

      if (res.ok && data.success) {
        return { target, server: serverName, success: true, message: data.message };
      }
      return {
        target,
        server: serverName,
        success: false,
        message: data.error || data.details || `Error ${res.status}`,
      };
    } catch (err) {
      return {
        target,
        server: serverName,
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    } finally {
      setProgress((p) => p + 1);
    }
  };

  const canSubmit =
    !submitting &&
    targets.valid.length > 0 &&
    !targetsError &&
    targetServers.length > 0 &&
    duration !== null &&
    reason.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setResult(null);
    setProgress(0);
    setSubmitting(true);

    try {
      const tasks = targets.valid.flatMap((target) =>
        targetServers.map((server) => ({ target, server }))
      );
      const attempts = await runWithConcurrency(tasks, BAN_CONCURRENCY, (t) =>
        banOne(t.target, t.server)
      );
      const summary = summarizeBanAttempts(attempts, targetServers, type);
      setResult(summary);

      if (summary.success) {
        setTargetsText('');
        setReason('');
        setType('ban');
        setDurationChoice(DEFAULT_DURATION);
        setCustomAmount('');
      } else {
        // Keep only the failed values for a retry.
        setTargetsText(summary.failedTargets.join('\n'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingServers) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Ban className="w-5 h-5" />
          Manual Ban
        </h2>
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading servers...
        </div>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Ban className="w-5 h-5" />
          Manual Ban
        </h2>
        <p className="text-slate-500 text-sm">
          No LAPI servers configured. Add servers to your config to enable manual banning.
        </p>
      </div>
    );
  }

  if (serversWithBan.length === 0) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Ban className="w-5 h-5" />
          Manual Ban
        </h2>
        <div className="p-3 bg-yellow-50 text-yellow-800 rounded-lg text-sm">
          <p className="font-medium">Machine credentials required</p>
          <p className="mt-1 text-yellow-700">
            Manual banning requires <code className="bg-yellow-100 px-1 rounded">machine_id</code>{' '}
            and <code className="bg-yellow-100 px-1 rounded">password</code> to be configured for at
            least one LAPI server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Ban className="w-5 h-5" />
        Manual Ban
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="server" className="block text-sm font-medium text-slate-700 mb-1">
            LAPI Server
          </label>
          <select
            id="server"
            value={selectedServer}
            onChange={(e) => setSelectedServer(e.target.value)}
            className={INPUT_CLASS}
            required
          >
            {serversWithBan.length > 1 && (
              <option value={ALL_SERVERS}>All servers ({serversWithBan.length})</option>
            )}
            {serversWithBan.map((server) => (
              <option key={server.name} value={server.name}>
                {server.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ip" className="block text-sm font-medium text-slate-700 mb-1">
            IP addresses or CIDR ranges (one per line, or separated by commas or spaces)
          </label>
          <textarea
            id="ip"
            value={targetsText}
            onChange={(e) => setTargetsText(e.target.value)}
            placeholder={'192.168.1.1\n2001:db8::1, 10.0.0.0/8'}
            className={`${INPUT_CLASS} font-mono resize-y`}
            rows={targets.valid.length + targets.invalid.length > 1 ? 4 : 2}
            aria-invalid={targetsError ? true : undefined}
            aria-describedby="ip-help"
            readOnly={submitting}
            required
          />
          <p
            id="ip-help"
            className={`text-xs mt-1 ${targetsError ? 'text-red-600' : 'text-slate-500'}`}
          >
            {targetsError ??
              (targets.valid.length > 1
                ? `${targets.valid.length} entries`
                : 'Supports single IPs or CIDR notation (e.g., 192.168.1.0/24)')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="ban-type" className="block text-sm font-medium text-slate-700 mb-1">
              Remediation
            </label>
            <select
              id="ban-type"
              value={type}
              onChange={(e) => setType(e.target.value as BanType)}
              className={INPUT_CLASS}
            >
              {BAN_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="duration" className="block text-sm font-medium text-slate-700 mb-1">
              Duration
            </label>
            <select
              id="duration"
              value={durationChoice}
              onChange={(e) => setDurationChoice(e.target.value)}
              className={INPUT_CLASS}
              required
            >
              {DURATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isCustomDuration && (
          <div>
            <div className="flex gap-2">
              <input
                type="number"
                id="custom-duration"
                aria-label="Custom duration"
                min={1}
                step={1}
                inputMode="numeric"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                placeholder="2"
                className={INPUT_CLASS}
                aria-invalid={durationError ? true : undefined}
                aria-describedby="custom-duration-help"
              />
              <select
                aria-label="Custom duration unit"
                value={customUnit}
                onChange={(e) => setCustomUnit(e.target.value as DurationUnit)}
                className={`${INPUT_CLASS} w-auto`}
              >
                {DURATION_UNITS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <p
              id="custom-duration-help"
              className={`text-xs mt-1 ${durationError ? 'text-red-600' : 'text-slate-500'}`}
            >
              {durationError ?? 'From 1 minute to 365 days'}
            </p>
          </div>
        )}

        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-slate-700 mb-1">
            Reason
          </label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain the context for this ban (e.g., repeated brute-force attempts, suspicious activity pattern...)"
            className={`${INPUT_CLASS} resize-none`}
            maxLength={500}
            rows={2}
            required
          />
          <p className="text-xs text-slate-500 mt-1">{reason.length}/500</p>
        </div>

        {result && (
          <div
            role="status"
            className={`p-3 rounded-lg ${
              result.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {result.success ? (
                <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
              )}
              <span className="text-sm font-medium break-words">{result.message}</span>
            </div>
            {result.failures.length > 1 && (
              <ul className="mt-2 ml-7 space-y-1">
                {result.failures.map((failure) => (
                  <li key={failure} className="text-xs font-mono break-words">
                    {failure}
                  </li>
                ))}
              </ul>
            )}
            {!result.success && (
              <p className="mt-2 ml-7 text-xs">The failed values were kept for a retry.</p>
            )}
          </div>
        )}

        <Button type="submit" disabled={!canSubmit} className="w-full">
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              {type === 'captcha' ? 'Applying captcha' : 'Banning'}
              {requestCount > 1 ? ` ${progress}/${requestCount}` : '...'}
            </>
          ) : (
            <>
              <Ban className="w-4 h-4 mr-2" />
              {banButtonLabel(type, targets.valid.length)}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
