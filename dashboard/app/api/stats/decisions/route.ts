import { NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(request: Request) {
  const { apiBase } = getApiConfig();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period');

  try {
    const url = period
      ? `${apiBase}/api/stats/decisions?period=${encodeURIComponent(period)}`
      : `${apiBase}/api/stats/decisions`;

    const res = await fetch(url, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch decision stats' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch decision stats' }, { status: 500 });
  }
}
