import { NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/audit/actors`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch audit users' }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch audit users' }, { status: 500 });
  }
}
