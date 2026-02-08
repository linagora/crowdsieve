import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'net';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';

/**
 * Extract the base IP from a value that may be an IP or CIDR notation.
 * For example: "185.226.196.0/24" -> "185.226.196.0"
 */
function extractIpFromValue(value: string): string {
  const slashIndex = value.indexOf('/');
  return slashIndex !== -1 ? value.substring(0, slashIndex) : value;
}

/**
 * GET /api/ip-info?ip=...
 * Accepts IP addresses or CIDR notation via query parameter.
 * This avoids URL routing issues with %2F in path segments.
 */
export async function GET(request: NextRequest) {
  const { apiBase } = getApiConfig();
  const ip = request.nextUrl.searchParams.get('ip');

  if (!ip) {
    return NextResponse.json({ error: 'Missing ip parameter' }, { status: 400 });
  }

  // Extract base IP if this is a CIDR range, then validate
  const baseIp = extractIpFromValue(ip);
  if (!isIP(baseIp)) {
    return NextResponse.json({ error: 'Invalid IP address format' }, { status: 400 });
  }

  try {
    const res = await fetch(`${apiBase}/api/ip-info/${encodeURIComponent(ip)}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to fetch IP info' }));
      return NextResponse.json(error, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch IP info' }, { status: 500 });
  }
}
