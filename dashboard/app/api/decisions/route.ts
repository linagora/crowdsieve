import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(request: NextRequest) {
  const { apiBase } = getApiConfig();
  const ip = request.nextUrl.searchParams.get('ip');

  if (!ip) {
    return NextResponse.json({ error: 'Missing ip parameter' }, { status: 400 });
  }

  try {
    const res = await fetch(`${apiBase}/api/decisions?ip=${encodeURIComponent(ip)}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to search decisions' }, { status: 500 });
  }
}
