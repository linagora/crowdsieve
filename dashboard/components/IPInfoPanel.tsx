'use client';

import { useEffect, useState } from 'react';
import { Globe, Server, Building, Mail, Loader2 } from 'lucide-react';
import type { IPInfo } from '@/lib/types';

interface IPInfoPanelProps {
  ip: string;
}

export function IPInfoPanel({ ip }: IPInfoPanelProps) {
  const [ipInfo, setIpInfo] = useState<IPInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ip) {
      setLoading(false);
      return;
    }

    const fetchIPInfo = async () => {
      try {
        setLoading(true);
        setError(null);

        const apiKey = process.env.NEXT_PUBLIC_API_KEY;
        const headers: HeadersInit = {};
        if (apiKey) {
          headers['X-API-Key'] = apiKey;
        }

        const res = await fetch(`/api/ip-info/${encodeURIComponent(ip)}`, {
          headers,
        });

        if (!res.ok) {
          throw new Error('Failed to fetch IP info');
        }

        const data = await res.json();
        setIpInfo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchIPInfo();
  }, [ip]);

  if (loading) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4">Network Information</h2>
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading IP information...
        </div>
      </div>
    );
  }

  if (error || !ipInfo) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4">Network Information</h2>
        <p className="text-slate-500 text-sm">Unable to fetch IP information</p>
      </div>
    );
  }

  const { reverseDns, whois } = ipInfo;
  const hasReverseDns = reverseDns && reverseDns.length > 0;
  const hasWhois = whois && (whois.organization || whois.netName || whois.descr);

  if (!hasReverseDns && !hasWhois) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4">Network Information</h2>
        <p className="text-slate-500 text-sm">No additional information available for this IP</p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4">Network Information</h2>
      <dl className="space-y-3">
        {/* Reverse DNS */}
        {hasReverseDns && (
          <div className="flex flex-col">
            <dt className="text-slate-600 flex items-center gap-2">
              <Server className="w-4 h-4" />
              Reverse DNS
            </dt>
            <dd className="mt-1 space-y-1">
              {reverseDns.map((hostname, idx) => (
                <div key={idx} className="font-mono text-sm bg-slate-50 px-2 py-1 rounded">
                  {hostname}
                </div>
              ))}
            </dd>
          </div>
        )}

        {/* WHOIS Information */}
        {hasWhois && (
          <>
            {whois.organization && (
              <div className="flex justify-between">
                <dt className="text-slate-600 flex items-center gap-2">
                  <Building className="w-4 h-4" />
                  Organization
                </dt>
                <dd className="text-right max-w-[60%]">{whois.organization}</dd>
              </div>
            )}

            {whois.descr && !whois.organization && (
              <div className="flex justify-between">
                <dt className="text-slate-600 flex items-center gap-2">
                  <Building className="w-4 h-4" />
                  Description
                </dt>
                <dd className="text-right max-w-[60%]">{whois.descr}</dd>
              </div>
            )}

            {whois.netName && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Network Name</dt>
                <dd className="font-mono text-sm">{whois.netName}</dd>
              </div>
            )}

            {whois.netRange && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Network Range</dt>
                <dd className="font-mono text-sm">{whois.netRange}</dd>
              </div>
            )}

            {whois.cidr && (
              <div className="flex justify-between">
                <dt className="text-slate-600">CIDR</dt>
                <dd className="font-mono text-sm">{whois.cidr}</dd>
              </div>
            )}

            {whois.country && (
              <div className="flex justify-between">
                <dt className="text-slate-600 flex items-center gap-2">
                  <Globe className="w-4 h-4" />
                  WHOIS Country
                </dt>
                <dd>{whois.country}</dd>
              </div>
            )}

            {whois.abuse && (
              <div className="flex justify-between">
                <dt className="text-slate-600 flex items-center gap-2">
                  <Mail className="w-4 h-4" />
                  Abuse Contact
                </dt>
                <dd className="font-mono text-sm">{whois.abuse}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </div>
  );
}
