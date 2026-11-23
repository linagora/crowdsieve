import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();
  const searchParams = request.nextUrl.searchParams;

  try {
    const res = await fetch(`${apiBase}/api/alerts?${searchParams}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}
