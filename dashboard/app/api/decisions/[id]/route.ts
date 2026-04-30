import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { getSessionUser, resolveActor } from '@/lib/oidc/session';

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

  // Forward the JSON body verbatim so the backend can validate the unban
  // reason / target IP. Reading as text keeps the proxy schema-agnostic.
  const body = await request.text();

  // Resolve the human user from the OIDC session for audit logging on the
  // backend. Failures are non-fatal: deletion can still proceed without an
  // actor recorded — the backend treats the header as optional.
  const user = await getSessionUser().catch(() => null);
  const actor = resolveActor(user);

  const headers: Record<string, string> = {
    ...(getApiHeaders() as Record<string, string>),
    'Content-Type': 'application/json',
  };
  if (actor) {
    headers['X-Crowdsieve-Actor'] = actor;
  }

  try {
    const res = await fetch(`${apiBase}/api/decisions/${id}?server=${encodeURIComponent(server)}`, {
      method: 'DELETE',
      headers,
      body,
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
