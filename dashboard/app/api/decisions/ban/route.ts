import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

export async function POST(request: NextRequest) {
  const { apiBase } = getApiConfig();

  try {
    const body = await request.json();

    const res = await fetch(`${apiBase}/api/decisions/ban`, {
      method: 'POST',
      headers: {
        ...getApiHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to post ban decision' }, { status: 500 });
  }
}
