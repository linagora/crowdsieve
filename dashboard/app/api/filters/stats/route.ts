import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();
  // Only `since` is forwarded; the proxy validates it.
  const since = request.nextUrl.searchParams.get('since');
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';

  try {
    const res = await fetch(`${apiBase}/api/filters/stats${qs}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch filter stats' }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Failed to fetch filter stats' }, { status: 500 });
  }
}
