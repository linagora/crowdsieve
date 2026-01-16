import { NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET() {
  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/lapi-servers`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch LAPI servers' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch LAPI servers' }, { status: 500 });
  }
}
