import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth, requireJsonContentType } from '@/lib/auth/guard';

/**
 * Run the current filter rules on a stored alert. Read-only, but the alert id
 * travels in a JSON body, so the route gets the same CSRF checks as writes.
 */
export async function POST(request: NextRequest) {
  const denied = (await requireAuth()) ?? requireJsonContentType(request);
  if (denied) return denied;

  let alertId: unknown;
  try {
    ({ alertId } = ((await request.json()) ?? {}) as { alertId?: unknown });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof alertId !== 'number' || !Number.isSafeInteger(alertId) || alertId < 1) {
    return NextResponse.json({ error: 'alertId must be a positive integer' }, { status: 400 });
  }

  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/filters/test`, {
      method: 'POST',
      headers: {
        ...(getApiHeaders() as Record<string, string>),
        'Content-Type': 'application/json',
      },
      // Only the alert id is forwarded, never the rest of the client body
      body: JSON.stringify({ alertId }),
    });

    const data = await res.json().catch(() => ({ error: 'Failed to test the alert' }));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Failed to test the alert' }, { status: 500 });
  }
}
