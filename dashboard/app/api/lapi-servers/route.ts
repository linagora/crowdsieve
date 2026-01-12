import { NextResponse } from 'next/server';

const API_BASE = process.env.API_URL || 'http://localhost:8080';
const API_KEY = process.env.DASHBOARD_API_KEY;

function getApiHeaders(): HeadersInit {
  const headers: HeadersInit = {};
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return headers;
}

export async function GET() {
  try {
    const res = await fetch(`${API_BASE}/api/lapi-servers`, {
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
