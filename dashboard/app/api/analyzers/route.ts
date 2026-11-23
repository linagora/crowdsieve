import { NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/analyzers`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch analyzers' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching analyzers:', error);
    return NextResponse.json({ error: 'Failed to fetch analyzers' }, { status: 500 });
  }
}
