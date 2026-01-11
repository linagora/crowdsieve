import dns from 'dns';
import net from 'net';

export interface IPInfo {
  ip: string;
  reverseDns: string[];
  whois: WhoisSummary | null;
  error?: string;
}

export interface WhoisSummary {
  netName?: string;
  netRange?: string;
  cidr?: string;
  organization?: string;
  country?: string;
  descr?: string;
  abuse?: string;
  raw?: string;
}

// WHOIS servers by registry
const WHOIS_SERVERS: Record<string, string> = {
  ARIN: 'whois.arin.net',
  RIPE: 'whois.ripe.net',
  APNIC: 'whois.apnic.net',
  LACNIC: 'whois.lacnic.net',
  AFRINIC: 'whois.afrinic.net',
};

const DEFAULT_WHOIS_SERVER = 'whois.iana.org';
const WHOIS_PORT = 43;
const WHOIS_TIMEOUT = 5000;
const DNS_TIMEOUT = 3000;

// Cache configuration
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_SIZE = 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple LRU cache with TTL for IP info results
 */
class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete existing to update position
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

// Global cache for IP info results
const ipInfoCache = new LRUCache<IPInfo>(CACHE_MAX_SIZE, CACHE_TTL_MS);

/**
 * Perform reverse DNS lookup for an IP address
 */
export async function reverseDnsLookup(ip: string): Promise<string[]> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve([]);
    }, DNS_TIMEOUT);

    dns.promises
      .reverse(ip)
      .then((hostnames) => {
        clearTimeout(timeout);
        resolve(hostnames);
      })
      .catch(() => {
        clearTimeout(timeout);
        resolve([]);
      });
  });
}

/**
 * Query a WHOIS server
 */
async function queryWhoisServer(server: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(WHOIS_PORT, server);
    let data = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('WHOIS timeout'));
    }, WHOIS_TIMEOUT);

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      socket.write(query + '\r\n');
    });

    socket.on('data', (chunk) => {
      data += chunk;
    });

    socket.on('end', () => {
      clearTimeout(timeout);
      resolve(data);
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Parse WHOIS response into a summary
 */
function parseWhoisResponse(raw: string): WhoisSummary {
  const lines = raw.split('\n');
  const summary: WhoisSummary = { raw };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    if (!value) continue;

    // Network name
    if (key === 'netname' || key === 'net-name') {
      summary.netName = value;
    }
    // Network range
    else if (key === 'netrange' || key === 'inetnum' || key === 'inet6num') {
      summary.netRange = value;
    }
    // CIDR
    else if (key === 'cidr') {
      summary.cidr = value;
    }
    // Organization
    else if (
      (key === 'orgname' || key === 'org-name' || key === 'organization') &&
      !summary.organization
    ) {
      summary.organization = value;
    }
    // Country
    else if (key === 'country' && !summary.country) {
      summary.country = value.toUpperCase();
    }
    // Description (RIPE style)
    else if (key === 'descr' && !summary.descr) {
      summary.descr = value;
    }
    // Abuse contact
    else if (lower.includes('abuse') && lower.includes('mail') && !summary.abuse) {
      summary.abuse = value;
    } else if (key === 'orgabuseemail' || key === 'abuse-mailbox') {
      summary.abuse = value;
    }
  }

  return summary;
}

/**
 * Detect which RIR to query based on initial IANA response.
 * IANA returns a "refer:" or "whois:" line pointing to the appropriate RIR.
 * We use an allowlist of known RIR servers to avoid matching arbitrary hostnames.
 */
function detectRir(ianaResponse: string): string | null {
  // Known RIR WHOIS server hostnames (exact match required)
  const rirServers: Record<string, string> = {
    'whois.arin.net': 'ARIN',
    'whois.ripe.net': 'RIPE',
    'whois.apnic.net': 'APNIC',
    'whois.lacnic.net': 'LACNIC',
    'whois.afrinic.net': 'AFRINIC',
  };

  // Match "refer:" or "whois:" lines in IANA response
  // Format: "refer:        whois.arin.net" or "whois:        whois.ripe.net"
  const referPattern = /^(?:refer|whois):\s*(\S+)/im;
  const match = referPattern.exec(ianaResponse);

  if (match) {
    const server = match[1].toLowerCase();
    // Only accept exact matches from our allowlist
    if (Object.prototype.hasOwnProperty.call(rirServers, server)) {
      return rirServers[server];
    }
  }

  return null;
}

/**
 * Perform WHOIS lookup for an IP address
 */
export async function whoisLookup(ip: string): Promise<WhoisSummary | null> {
  try {
    // First query IANA to find the appropriate RIR
    const ianaResponse = await queryWhoisServer(DEFAULT_WHOIS_SERVER, ip);
    const rir = detectRir(ianaResponse);

    if (!rir || !WHOIS_SERVERS[rir]) {
      // Try to parse IANA response directly
      return parseWhoisResponse(ianaResponse);
    }

    // Query the appropriate RIR
    const rirServer = WHOIS_SERVERS[rir];
    const rirResponse = await queryWhoisServer(rirServer, ip);

    return parseWhoisResponse(rirResponse);
  } catch {
    return null;
  }
}

/**
 * Get complete IP information (reverse DNS + WHOIS)
 * Results are cached for 1 hour to reduce load on WHOIS servers
 */
export async function getIPInfo(ip: string): Promise<IPInfo> {
  // Validate IP address
  if (!net.isIP(ip)) {
    return {
      ip,
      reverseDns: [],
      whois: null,
      error: 'Invalid IP address',
    };
  }

  // Check cache first
  const cached = ipInfoCache.get(ip);
  if (cached) {
    return cached;
  }

  // Run lookups in parallel
  const [reverseDns, whois] = await Promise.all([reverseDnsLookup(ip), whoisLookup(ip)]);

  const result: IPInfo = {
    ip,
    reverseDns,
    whois,
  };

  // Cache the result
  ipInfoCache.set(ip, result);

  return result;
}
