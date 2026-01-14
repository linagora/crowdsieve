'use client';

import { useState, useEffect } from 'react';
import { Ban, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LapiServer, BanDecisionResponse } from '@/lib/types';

const DEFAULT_DURATION = '4h';

const DURATION_OPTIONS = [
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: '24 hours', value: '24h' },
  { label: '7 days', value: '168h' },
  { label: '30 days', value: '720h' },
];

const ALL_SERVERS = '__all__';

interface BanIPFormProps {
  initialIp?: string;
}

interface BanResult {
  success: boolean;
  message: string;
  details?: Array<{ server: string; success: boolean; message: string }>;
}

export function BanIPForm({ initialIp = '' }: BanIPFormProps) {
  const [servers, setServers] = useState<LapiServer[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [selectedServer, setSelectedServer] = useState('');
  const [ip, setIp] = useState(initialIp);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BanResult | null>(null);

  useEffect(() => {
    const fetchServers = async () => {
      try {
        const res = await fetch('/api/lapi-servers');
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
    setIp(initialIp);
  }, [initialIp]);

  const banOnServer = async (
    serverName: string
  ): Promise<{ server: string; success: boolean; message: string }> => {
    try {
      const res = await fetch('/api/decisions/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: serverName,
          ip,
          duration,
          reason: reason.trim(),
        }),
      });

      const data: BanDecisionResponse = await res.json();

      if (res.ok && data.success) {
        return { server: serverName, success: true, message: data.message };
      } else {
        return {
          server: serverName,
          success: false,
          message: data.error || data.details || 'Failed',
        };
      }
    } catch (err) {
      return {
        server: serverName,
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  };

  // Filter servers that can ban (have machine credentials)
  const serversWithBan = servers.filter((s) => s.canBan);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    setSubmitting(true);

    try {
      if (selectedServer === ALL_SERVERS) {
        // Ban on all servers with machine credentials in parallel
        const results = await Promise.all(serversWithBan.map((s) => banOnServer(s.name)));
        const successCount = results.filter((r) => r.success).length;
        const allSuccess = successCount === results.length;

        setResult({
          success: allSuccess,
          message: allSuccess
            ? `IP ${ip} banned on all ${results.length} servers`
            : `IP ${ip} banned on ${successCount}/${results.length} servers`,
          details: results,
        });

        if (allSuccess) {
          setIp('');
          setReason('');
          setDuration(DEFAULT_DURATION);
        }
      } else {
        // Ban on single server
        const res = await banOnServer(selectedServer);

        if (res.success) {
          setResult({ success: true, message: res.message });
          setIp('');
          setReason('');
          setDuration(DEFAULT_DURATION);
        } else {
          setResult({ success: false, message: res.message });
        }
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
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
            className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary"
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
            IP Address
          </label>
          <input
            type="text"
            id="ip"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.1 or 2001:db8::1"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary font-mono"
            required
          />
        </div>

        <div>
          <label htmlFor="duration" className="block text-sm font-medium text-slate-700 mb-1">
            Duration
          </label>
          <select
            id="duration"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary"
            required
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-slate-700 mb-1">
            Reason
          </label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain the context for this ban (e.g., repeated brute-force attempts, suspicious activity pattern...)"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crowdsec-primary resize-none"
            maxLength={500}
            rows={2}
            required
          />
          <p className="text-xs text-slate-500 mt-1">{reason.length}/500</p>
        </div>

        {result && (
          <div
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
              <span className="text-sm font-medium">{result.message}</span>
            </div>
            {result.details && result.details.length > 1 && (
              <ul className="mt-2 ml-7 space-y-1">
                {result.details.map((d) => (
                  <li key={d.server} className="text-xs flex items-center gap-1">
                    {d.success ? (
                      <CheckCircle2 className="w-3 h-3 text-green-600" />
                    ) : (
                      <AlertCircle className="w-3 h-3 text-red-600" />
                    )}
                    <span className="font-mono">{d.server}</span>
                    {!d.success && <span className="text-red-600">- {d.message}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Button
          type="submit"
          disabled={submitting || !ip || !selectedServer || !reason.trim()}
          className="w-full"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Banning...
            </>
          ) : (
            <>
              <Ban className="w-4 h-4 mr-2" />
              Ban IP
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
