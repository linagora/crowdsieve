import { NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/filters`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch filter rules' }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Failed to fetch filter rules' }, { status: 500 });
  }
}
