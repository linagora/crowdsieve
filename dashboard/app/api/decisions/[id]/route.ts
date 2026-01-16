import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { apiBase } = getApiConfig();
  const { id } = await params;
  const server = request.nextUrl.searchParams.get('server');

  if (!server) {
    return NextResponse.json({ error: 'Missing server parameter' }, { status: 400 });
  }

  try {
    const res = await fetch(`${apiBase}/api/decisions/${id}?server=${encodeURIComponent(server)}`, {
      method: 'DELETE',
      headers: getApiHeaders(),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to delete decision' }, { status: 500 });
  }
}
