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

  // Run lookups in parallel
  const [reverseDns, whois] = await Promise.all([reverseDnsLookup(ip), whoisLookup(ip)]);

  return {
    ip,
    reverseDns,
    whois,
  };
}
