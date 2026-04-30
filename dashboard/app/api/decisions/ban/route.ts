import { NextRequest, NextResponse } from 'next/server';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { getSessionUser, resolveActor } from '@/lib/oidc/session';

export async function POST(request: NextRequest) {
  const { apiBase } = getApiConfig();

  try {
    const body = await request.json();

    // Resolve the human user from the OIDC session for audit logging on the
    // backend. Failures are non-fatal: the ban can still proceed without an
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

    const res = await fetch(`${apiBase}/api/decisions/ban`, {
      method: 'POST',
      headers,
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
