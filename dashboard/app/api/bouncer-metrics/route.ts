import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(request: NextRequest) {
  const { apiBase } = getApiConfig();
  const searchParams = request.nextUrl.searchParams;
  const qs = searchParams.toString();

  try {
    const url = qs ? `${apiBase}/api/bouncer-metrics?${qs}` : `${apiBase}/api/bouncer-metrics`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch bouncer metrics' },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch bouncer metrics' }, { status: 500 });
  }
}
