import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'net';
import { getApiConfig, getApiHeaders } from '@/lib/api-config';
import { requireAuth } from '@/lib/auth/guard';

/**
 * Extract the base IP from a value that may be an IP or CIDR notation.
 * Handles both decoded ("/") and URL-encoded ("%2F") slashes.
 * For example: "185.226.196.0/24" -> "185.226.196.0"
 */
function extractIpFromValue(value: string): string {
  // First try to decode in case Next.js didn't decode %2F
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Already decoded or invalid encoding, use as-is
  }
  const slashIndex = decoded.indexOf('/');
  return slashIndex !== -1 ? decoded.substring(0, slashIndex) : decoded;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ ip: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { apiBase } = getApiConfig();
  const { ip: rawIp } = await params;

  // Decode the IP in case it contains URL-encoded characters
  let ip = rawIp;
  try {
    ip = decodeURIComponent(rawIp);
  } catch {
    // Already decoded or invalid encoding
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
