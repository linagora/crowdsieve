import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireOperator, requireJsonContentType } from '@/lib/auth/guard';
import { isValidTargetName } from '@/lib/notifications';

/**
 * Send a test message to a notification target. The client posts `{}` as
 * JSON: the body is not used, but the JSON content type is required (CSRF).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const denied = (await requireOperator()) ?? requireJsonContentType(request);
  if (denied) return denied;

  const { name } = await params;
  if (!isValidTargetName(name)) {
    return NextResponse.json({ error: 'Invalid target name' }, { status: 400 });
  }

  const { apiBase } = getApiConfig();

  try {
    const res = await fetch(`${apiBase}/api/notifications/${encodeURIComponent(name)}/test`, {
      method: 'POST',
      headers: getApiHeaders(),
    });
    const data = await res.json().catch(() => ({ error: 'Failed to send the test notification' }));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Failed to send the test notification' }, { status: 500 });
  }
}
