'use client';

import { useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { StoredAlert } from '@/lib/types';

interface WorldMapProps {
  alerts: StoredAlert[];
  height?: string;
  onLocationSelect?: (location: { lat: number; lng: number } | null) => void;
}

export function WorldMap({ alerts, height = '400px', onLocationSelect }: WorldMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);

  // Use ref for callback to avoid re-creating markers when callback changes
  const onLocationSelectRef = useRef(onLocationSelect);
  onLocationSelectRef.current = onLocationSelect;

  // Group alerts by location
  const alertsByLocation = useMemo(() => {
    const grouped = new Map<string, StoredAlert[]>();

    alerts.forEach((alert) => {
      const lat = alert.geoLatitude;
      const lng = alert.geoLongitude;

      if (lat && lng) {
        const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
        if (!grouped.has(key)) {
          grouped.set(key, []);
        }
        grouped.get(key)!.push(alert);
      }
    });

    return grouped;
  }, [alerts]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Update markers
  useEffect(() => {
    if (!markersRef.current) return;

    markersRef.current.clearLayers();

    alertsByLocation.forEach((locationAlerts, key) => {
      const [lat, lng] = key.split(',').map(Number);
      const count = locationAlerts.length;
      const latestAlert = locationAlerts[0];

      const icon = L.divIcon({
        className: 'custom-marker',
        html: `
          <div style="position: relative; display: flex; align-items: center; justify-content: center;">
            <div style="position: absolute; width: 32px; height: 32px; background: ${
              latestAlert.filtered ? '#eab308' : '#22c55e'
            }; border-radius: 50%; opacity: 0.3; animation: ping 1.5s infinite;"></div>
            <div style="position: relative; width: 24px; height: 24px; background: ${
              latestAlert.filtered ? '#eab308' : '#22c55e'
            }; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 10px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
              ${count > 99 ? '99+' : count}
            </div>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const marker = L.marker([lat, lng], { icon });

      const popupContent = `
        <div style="padding: 8px;">
          <div style="font-weight: bold;">${latestAlert.geoCity || latestAlert.geoCountryName || 'Unknown'}</div>
          <div style="font-size: 12px; color: #666;">${count} alert${count > 1 ? 's' : ''}</div>
          <div style="font-size: 11px; margin-top: 4px;">
            Latest: ${latestAlert.scenario}
          </div>
        </div>
      `;

      marker.bindPopup(popupContent);

      // Emit location selection on popup open/close
      marker.on('popupopen', () => {
        onLocationSelectRef.current?.({ lat, lng });
      });
      marker.on('popupclose', () => {
        onLocationSelectRef.current?.(null);
      });

      marker.addTo(markersRef.current!);
    });
  }, [alertsByLocation]);

  return (
    <div ref={mapRef} style={{ height, width: '100%' }} className="rounded-lg overflow-hidden" />
  );
}
