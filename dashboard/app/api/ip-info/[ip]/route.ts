import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'net';

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

  // Validate IP address format before forwarding to backend
  if (!isIP(ip)) {
    return NextResponse.json({ error: 'Invalid IP address format' }, { status: 400 });
  }

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
  } catch {
    return NextResponse.json({ error: 'Failed to fetch IP info' }, { status: 500 });
  }
}
