import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.API_URL || 'http://localhost:8080';
const API_KEY = process.env.DASHBOARD_API_KEY;

function getApiHeaders(): HeadersInit {
  const headers: HeadersInit = {};
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return headers;
}

export async function GET(request: NextRequest) {
  const ip = request.nextUrl.searchParams.get('ip');

  if (!ip) {
    return NextResponse.json({ error: 'Missing ip parameter' }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_BASE}/api/decisions?ip=${encodeURIComponent(ip)}`, {
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
