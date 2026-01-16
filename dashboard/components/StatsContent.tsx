'use client';

import { useState, useEffect } from 'react';
import { Calendar, Clock, Globe, Shield, BarChart3, TrendingUp } from 'lucide-react';
import { BarChart } from '@/components/charts/BarChart';
import { HorizontalBarChart } from '@/components/charts/HorizontalBarChart';
import { TrendChart } from '@/components/charts/TrendChart';
import type { TimeDistributionStats } from '@/lib/types';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2 || code === 'Unknown') return '';
  const codePoints = code
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

interface StatsContentProps {
  initialStats: TimeDistributionStats;
}

export function StatsContent({ initialStats }: StatsContentProps) {
  const [stats, setStats] = useState(initialStats);
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('30d');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function fetchStats() {
      setLoading(true);
      try {
        const res = await fetch(`/api/stats/distribution?period=${period}`);
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, [period]);

  // Transform day of week data (reorder Mon-Sun)
  const dayOfWeekData = (() => {
    const dataMap = new Map(stats.byDayOfWeek.map((d) => [d.day, d.count]));
    return DAY_ORDER.map((day, index) => ({
      label: DAY_LABELS[index],
      value: dataMap.get(day) || 0,
    }));
  })();

  // Transform hour of day data (ensure all 24 hours)
  const hourOfDayData = (() => {
    const dataMap = new Map(stats.byHourOfDay.map((d) => [d.hour, d.count]));
    return Array.from({ length: 24 }, (_, hour) => ({
      label: hour.toString().padStart(2, '0'),
      value: dataMap.get(hour) || 0,
    }));
  })();

  const countryData = stats.byCountry.map((c) => ({
    label: c.countryName || c.countryCode || 'Unknown',
    value: c.count,
    flag: countryCodeToFlag(c.countryCode),
  }));

  const scenarioData = stats.byScenario.map((s) => ({
    label: s.scenario.split('/').pop() || s.scenario,
    value: s.count,
  }));

  const periodLabel =
    period === '7d' ? '7 days' : period === '30d' ? '30 days' : 'All time';

  return (
    <div className={`space-y-6 ${loading ? 'opacity-70' : ''}`}>
      {/* Header with period selector */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-2xl font-bold">Statistics</h2>
        <div className="flex gap-2">
          {(['7d', '30d', 'all'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-crowdsec-accent text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {p === '7d' ? '7 days' : p === '30d' ? '30 days' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Total Alerts</p>
              <p className="text-2xl font-bold mt-1">{stats.totalAlerts.toLocaleString()}</p>
              <p className="text-xs text-slate-400 mt-1">{periodLabel}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50">
              <Shield className="w-5 h-5 text-blue-500" />
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Countries</p>
              <p className="text-2xl font-bold mt-1">{stats.byCountry.length}</p>
              <p className="text-xs text-slate-400 mt-1">unique sources</p>
            </div>
            <div className="p-2 rounded-lg bg-purple-50">
              <Globe className="w-5 h-5 text-purple-500" />
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Scenarios</p>
              <p className="text-2xl font-bold mt-1">{stats.byScenario.length}</p>
              <p className="text-xs text-slate-400 mt-1">attack types</p>
            </div>
            <div className="p-2 rounded-lg bg-green-50">
              <BarChart3 className="w-5 h-5 text-green-500" />
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-slate-500">Date Range</p>
              <p className="text-sm font-medium mt-1">
                {stats.dateRange.from
                  ? new Date(stats.dateRange.from).toLocaleDateString('fr-FR')
                  : 'N/A'}
              </p>
              <p className="text-xs text-slate-400">
                to{' '}
                {stats.dateRange.to
                  ? new Date(stats.dateRange.to).toLocaleDateString('fr-FR')
                  : 'N/A'}
              </p>
            </div>
            <div className="p-2 rounded-lg bg-orange-50">
              <Calendar className="w-5 h-5 text-orange-500" />
            </div>
          </div>
        </div>
      </div>

      {/* Time Distribution Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BarChart data={dayOfWeekData} title="Alerts by Day of Week" colorClass="bg-blue-500" />
        <BarChart data={hourOfDayData} title="Alerts by Hour of Day" colorClass="bg-green-500" />
      </div>

      {/* Country and Scenario Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HorizontalBarChart data={countryData} title="Top Countries" maxBars={10} />
        <HorizontalBarChart data={scenarioData} title="Top Scenarios" maxBars={10} />
      </div>

      {/* Daily Trend - Full Width */}
      {stats.dailyTrend.length > 0 && (
        <TrendChart data={stats.dailyTrend} title="Daily Trend" />
      )}
    </div>
  );
}
