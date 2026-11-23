import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

// Query parameters of the proxy's GET /api/audit (validated there).
const FORWARDED_PARAMS = ['actor', 'action', 'ip', 'since', 'until', 'limit', 'offset'];

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();
  const query = new URLSearchParams();
  for (const name of FORWARDED_PARAMS) {
    const value = request.nextUrl.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }

  try {
    const res = await fetch(`${apiBase}/api/audit?${query}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });
    const data = await res.json().catch(() => null);

    if (res.status === 400) {
      return NextResponse.json(
        { error: data?.error || 'Invalid audit log query' },
        { status: 400 }
      );
    }
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch audit log' }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch audit log' }, { status: 500 });
  }
}
