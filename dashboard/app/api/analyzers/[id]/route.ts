import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { apiBase } = getApiConfig();
  const { id } = await params;

  try {
    const res = await fetch(`${apiBase}/api/analyzers/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch analyzer' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching analyzer:', error);
    return NextResponse.json({ error: 'Failed to fetch analyzer' }, { status: 500 });
  }
}
