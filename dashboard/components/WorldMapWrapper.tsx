'use client';

import dynamic from 'next/dynamic';
import type { StoredAlert } from '@/lib/types';

const WorldMap = dynamic(() => import('./WorldMap').then((mod) => mod.WorldMap), {
  ssr: false,
  loading: () => (
    <div className="h-[400px] w-full bg-slate-100 animate-pulse rounded-lg flex items-center justify-center">
      <span className="text-slate-400">Loading map...</span>
    </div>
  ),
});

interface WorldMapWrapperProps {
  alerts: StoredAlert[];
}

export function WorldMapWrapper({ alerts }: WorldMapWrapperProps) {
  return <WorldMap alerts={alerts} />;
}
