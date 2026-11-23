import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

// Query parameters forwarded to the proxy, which validates them.
const FORWARDED_PARAMS = ['server', 'type', 'origin', 'scenario', 'value', 'include_shared'];

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();
  const params = new URLSearchParams();
  for (const name of FORWARDED_PARAMS) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) params.set(name, value);
  }
  const query = params.toString();

  try {
    const res = await fetch(`${apiBase}/api/decisions/active${query ? `?${query}` : ''}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to list active decisions' }, { status: 500 });
  }
}
