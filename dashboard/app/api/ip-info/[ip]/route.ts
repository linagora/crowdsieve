import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.API_URL || process.env.PROXY_URL || 'http://localhost:8080';
const API_KEY = process.env.DASHBOARD_API_KEY;

function getApiHeaders(): HeadersInit {
  const headers: HeadersInit = {};
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return headers;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ ip: string }> }) {
  const { ip } = await params;

  try {
    const res = await fetch(`${API_BASE}/api/ip-info/${encodeURIComponent(ip)}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to fetch IP info' }));
      return NextResponse.json(error, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('API proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch IP info' }, { status: 500 });
  }
}
