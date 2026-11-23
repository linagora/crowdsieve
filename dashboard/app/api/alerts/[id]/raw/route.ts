import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';
import { isValidAlertId } from '@/lib/alertFilters';

/**
 * Raw JSON stored for an alert. An explicit handler (rather than the
 * `/api/alerts/:path*` rewrite to the proxy) so the session is validated and
 * the proxy API key is added server-side.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await params;
  if (!isValidAlertId(id)) {
    return NextResponse.json({ error: 'Invalid alert id' }, { status: 400 });
  }

  const { apiBase } = getApiConfig();
  try {
    const res = await fetch(`${apiBase}/api/alerts/${encodeURIComponent(id)}/raw`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const error =
        res.status === 404
          ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error ||
            'Raw data not stored'
          : 'Failed to fetch raw alert';
      // Do not relay the proxy's own 401/403 as a dashboard session error.
      const status = res.status === 404 || res.status === 400 ? res.status : 502;
      return NextResponse.json({ error }, { status });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Failed to fetch raw alert' }, { status: 500 });
  }
}
