'use client';

import { memo } from 'react';
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
  onLocationSelect?: (location: { lat: number; lng: number } | null) => void;
}

function WorldMapWrapperInner({ alerts, onLocationSelect }: WorldMapWrapperProps) {
  return <WorldMap alerts={alerts} onLocationSelect={onLocationSelect} />;
}

// Prevent re-renders when only the callback changes (which happens on parent state change)
// Only re-render when alerts actually change
export const WorldMapWrapper = memo(WorldMapWrapperInner, (prevProps, nextProps) => {
  // Return true if props are equal (should NOT re-render)
  // Use reference equality for alerts array - parent should create new array only when data changes
  return prevProps.alerts === nextProps.alerts;
});
