import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'net';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(request: NextRequest, { params }: { params: Promise<{ ip: string }> }) {
  const { apiBase } = getApiConfig();
  const { ip } = await params;

  // Validate IP address format before forwarding to backend
  if (!isIP(ip)) {
    return NextResponse.json({ error: 'Invalid IP address format' }, { status: 400 });
  }

  try {
    const res = await fetch(`${apiBase}/api/ip-info/${encodeURIComponent(ip)}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to fetch IP info' }));
      return NextResponse.json(error, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch IP info' }, { status: 500 });
  }
}
