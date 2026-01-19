import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { apiBase } = getApiConfig();
  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;

  try {
    const res = await fetch(
      `${apiBase}/api/analyzers/${encodeURIComponent(id)}/runs?${searchParams}`,
      {
        cache: 'no-store',
        headers: getApiHeaders(),
      }
    );

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch analyzer runs' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching analyzer runs:', error);
    return NextResponse.json({ error: 'Failed to fetch analyzer runs' }, { status: 500 });
  }
}
