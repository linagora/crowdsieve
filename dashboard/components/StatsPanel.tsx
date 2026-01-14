'use client';

import { useState, useEffect } from 'react';
import { Shield, Globe, Filter, Send } from 'lucide-react';
import type { AlertStats } from '@/lib/types';
import { fetchStats } from '@/lib/api';

interface StatsPanelProps {
  stats: AlertStats;
  autoRefreshInterval?: number;
}

const DEFAULT_AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

export function StatsPanel({
  stats: initialStats,
  autoRefreshInterval = DEFAULT_AUTO_REFRESH_INTERVAL,
}: StatsPanelProps) {
  const [stats, setStats] = useState<AlertStats>(initialStats);

  // Auto-refresh stats
  useEffect(() => {
    if (!autoRefreshInterval || autoRefreshInterval <= 0) return;

    const intervalId = setInterval(async () => {
      try {
        const newStats = await fetchStats();
        setStats(newStats);
      } catch {
        // Silently ignore auto-refresh errors
      }
    }, autoRefreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefreshInterval]);
  const cards = [
    {
      title: 'Total Alerts',
      value: stats.total.toLocaleString(),
      icon: Shield,
      color: 'text-blue-500',
      bgColor: 'bg-blue-50',
    },
    {
      title: 'Filtered',
      value: stats.filtered.toLocaleString(),
      icon: Filter,
      color: 'text-yellow-500',
      bgColor: 'bg-yellow-50',
    },
    {
      title: 'Forwarded',
      value: stats.forwarded.toLocaleString(),
      icon: Send,
      color: 'text-green-500',
      bgColor: 'bg-green-50',
    },
    {
      title: 'Top Country',
      value: stats.topCountries[0]?.country || 'N/A',
      subValue: stats.topCountries[0] ? `${stats.topCountries[0].count} alerts` : undefined,
      icon: Globe,
      color: 'text-purple-500',
      bgColor: 'bg-purple-50',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div key={card.title} className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">{card.title}</p>
              <p className="text-2xl font-bold mt-1">{card.value}</p>
              {card.subValue && <p className="text-xs text-slate-400 mt-1">{card.subValue}</p>}
            </div>
            <div className={`p-2 rounded-lg ${card.bgColor}`}>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
