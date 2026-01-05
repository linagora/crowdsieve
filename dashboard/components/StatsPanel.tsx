'use client';

import { Shield, Globe, Filter, Send } from 'lucide-react';
import type { AlertStats } from '@/lib/types';

interface StatsPanelProps {
  stats: AlertStats;
}

export function StatsPanel({ stats }: StatsPanelProps) {
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
