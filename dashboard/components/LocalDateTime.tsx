'use client';

import { useEffect, useState } from 'react';
import { formatUtcDateTime } from '@/lib/dateTime';

interface LocalDateTimeProps {
  /** ISO date string (or Date) to render in the browser's time zone. */
  value?: string | Date | null;
  /** Rendered when the value is missing or invalid. */
  fallback?: string;
}

/**
 * Render a date in the browser's local time zone.
 *
 * Server components cannot know the browser time zone, so the server markup
 * (and the first client render) uses a stable UTC representation. The local
 * formatting is applied right after mount, which avoids a hydration mismatch.
 */
export function LocalDateTime({ value, fallback = 'N/A' }: LocalDateTimeProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!value) return <>{fallback}</>;

  const date = value instanceof Date ? value : new Date(value);
  const stable = formatUtcDateTime(date);
  if (!stable) return <>{fallback}</>;

  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {mounted ? date.toLocaleString() : stable}
    </time>
  );
}
