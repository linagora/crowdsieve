import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { apiBase } = getApiConfig();
  const { id } = await params;

  try {
    const res = await fetch(`${apiBase}/api/analyzers/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to trigger analyzer run' },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to trigger analyzer run' }, { status: 500 });
  }
}
