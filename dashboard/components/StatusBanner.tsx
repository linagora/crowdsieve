'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useStatus } from '@/components/hooks/useStatus';
import { bannerMessage } from '@/lib/status';

const POLL_INTERVAL_MS = 30_000;

/**
 * Thin red banner under the header when CAPI forwarding or a LAPI server has
 * a problem. Hidden on the login page, on the status page itself, and when
 * the API answers 401 (not signed in).
 */
export function StatusBanner() {
  const pathname = usePathname();
  const hidden = pathname === '/login' || pathname === '/status';
  const { status, unauthorized } = useStatus(POLL_INTERVAL_MS);

  if (hidden || unauthorized || !status || status.problems.length === 0) return null;

  const [first, ...others] = status.problems;
  return (
    <div role="alert" className="bg-red-600 text-white text-sm">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>
          {bannerMessage(first)}
          {others.length > 0 ? ` (+${others.length} more)` : ''} —{' '}
          <Link href="/status" className="underline font-medium">
            see Status
          </Link>
        </span>
      </div>
    </div>
  );
}
