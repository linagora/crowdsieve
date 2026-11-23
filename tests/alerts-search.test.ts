/**
 * Alert search in the storage layer (SQLite): IP / CIDR (`sourceIp`), country,
 * limit/offset semantics when a CIDR search post-filters its candidates, and
 * the `allCountries` list of getStats.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { initializeDatabase, closeDatabase, getDatabaseContext } from '../src/db/index.js';
import {
  alertSourceInRange,
  cidrLikePattern,
  createStorage,
  MAX_CIDR_SCAN_ROWS,
} from '../src/storage/index.js';
import { parseCidr } from '../src/filters/cidr.js';
import type { Config } from '../src/config/index.js';

const logger = pino({ level: 'silent' });
let tmpDir: string;

interface SeedRow {
  scenario?: string;
  receivedAt: string;
  sourceScope?: string;
  sourceIp?: string | null;
  sourceValue?: string | null;
  sourceRange?: string | null;
  geoCountryCode?: string | null;
  geoCountryName?: string | null;
  filtered?: boolean;
  localAudit?: boolean;
}

function seed(rows: SeedRow[]): void {
  const { db, schema } = getDatabaseContext();
  const values = rows.map((r) => ({
    scenario: r.scenario ?? 'crowdsecurity/ssh-bf',
    receivedAt: r.receivedAt,
    sourceScope: r.sourceScope ?? 'ip',
    sourceIp: r.sourceIp ?? null,
    sourceValue: r.sourceValue ?? r.sourceIp ?? null,
    sourceRange: r.sourceRange ?? null,
    geoCountryCode: r.geoCountryCode ?? null,
    geoCountryName: r.geoCountryName ?? null,
    filtered: r.filtered ?? false,
    forwardedToCapi: !(r.filtered ?? false),
    localAudit: r.localAudit ?? false,
  }));
  // SQLite caps the number of bound parameters per statement.
  for (let i = 0; i < values.length; i += 500) {
    (db.insert(schema.alerts).values(values.slice(i, i + 500)) as unknown as { run(): void }).run();
  }
}

/** ISO timestamp `minutes` minutes after a fixed origin. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + minutes * 60_000).toISOString();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsieve-alerts-search-'));
  const config = {
    proxy: { listen_port: 8080, capi_url: 'https://api.crowdsec.net' },
    storage: { type: 'sqlite', path: path.join(tmpDir, 'test.db'), retention_days: 30 },
    lapi_servers: [],
  } as unknown as Config;
  await initializeDatabase(config, logger);
});

afterAll(async () => {
  await closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  const { db, schema } = getDatabaseContext();
  (db.delete(schema.decisions) as unknown as { run(): void }).run();
  (db.delete(schema.alerts) as unknown as { run(): void }).run();
});

describe('cidrLikePattern', () => {
  it('uses the octets fixed by an IPv4 prefix', () => {
    expect(cidrLikePattern(parseCidr('203.0.113.0/24'))).toBe('203.0.113.%');
    expect(cidrLikePattern(parseCidr('203.0.112.0/20'))).toBe('203.0.%');
    expect(cidrLikePattern(parseCidr('10.0.0.0/8'))).toBe('10.%');
    expect(cidrLikePattern(parseCidr('203.0.113.7/32'))).toBe('203.0.113.7%');
  });

  it('only checks the family for short IPv4 prefixes and for IPv6', () => {
    expect(cidrLikePattern(parseCidr('0.0.0.0/0'))).toBe('%.%.%.%');
    expect(cidrLikePattern(parseCidr('128.0.0.0/7'))).toBe('%.%.%.%');
    expect(cidrLikePattern(parseCidr('2001:db8::/32'))).toBe('%:%');
  });

  it('ignores host bits of the searched base', () => {
    expect(cidrLikePattern(parseCidr('203.0.113.77/24'))).toBe('203.0.113.%');
  });
});

describe('alertSourceInRange', () => {
  const range = parseCidr('203.0.113.0/24');

  it('matches a source IP or value inside the range', () => {
    expect(alertSourceInRange(range, { sourceIp: '203.0.113.7' })).toBe(true);
    expect(alertSourceInRange(range, { sourceValue: '203.0.113.255' })).toBe(true);
    expect(alertSourceInRange(range, { sourceIp: '203.0.114.1' })).toBe(false);
  });

  it('matches a stored range equal to or inside the searched one', () => {
    expect(alertSourceInRange(range, { sourceRange: '203.0.113.0/24' })).toBe(true);
    expect(alertSourceInRange(range, { sourceValue: '203.0.113.128/25' })).toBe(true);
    expect(alertSourceInRange(range, { sourceRange: '203.0.0.0/16' })).toBe(false);
  });

  it('ignores values that are not addresses and never crosses families', () => {
    expect(alertSourceInRange(range, { sourceValue: 'FR', sourceIp: null })).toBe(false);
    expect(alertSourceInRange(range, { sourceIp: '::ffff:203.0.113.7' })).toBe(false);
    expect(alertSourceInRange(range, {})).toBe(false);
  });
});

describe('queryAlerts — IP and CIDR search', () => {
  const storage = createStorage();

  it('keeps the exact match for a single address', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '203.0.113.7' },
      { receivedAt: at(2), sourceIp: '203.0.113.70' },
      { receivedAt: at(3), sourceScope: 'range', sourceIp: null, sourceValue: '203.0.113.7' },
    ]);

    const results = await storage.queryAlerts({ sourceIp: '203.0.113.7' });

    expect(results.map((a) => a.sourceValue)).toEqual(['203.0.113.7', '203.0.113.7']);
  });

  it('lists the alerts of an IPv4 range, newest first', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '203.0.113.7' },
      { receivedAt: at(2), sourceIp: '203.0.114.7' },
      { receivedAt: at(3), sourceIp: '203.0.11.3' },
      { receivedAt: at(4), sourceIp: '203.0.113.200' },
      { receivedAt: at(5), sourceIp: '2001:db8::1' },
    ]);

    const results = await storage.queryAlerts({ sourceIp: '203.0.113.0/24' });

    expect(results.map((a) => a.sourceIp)).toEqual(['203.0.113.200', '203.0.113.7']);
  });

  it('filters out the prefilter candidates outside a non-octet prefix', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '203.0.112.1' },
      { receivedAt: at(2), sourceIp: '203.0.127.254' },
      { receivedAt: at(3), sourceIp: '203.0.128.1' },
      { receivedAt: at(4), sourceIp: '203.0.111.255' },
    ]);

    const results = await storage.queryAlerts({ sourceIp: '203.0.112.0/20' });

    expect(results.map((a) => a.sourceIp)).toEqual(['203.0.127.254', '203.0.112.1']);
  });

  it('matches range-scoped alerts equal to or inside the searched range', async () => {
    seed([
      {
        receivedAt: at(1),
        sourceScope: 'range',
        sourceValue: '198.51.100.0/24',
        sourceRange: '198.51.100.0/24',
      },
      {
        receivedAt: at(2),
        sourceScope: 'range',
        sourceValue: '198.51.100.128/25',
        sourceRange: '198.51.100.128/25',
      },
      {
        receivedAt: at(3),
        sourceScope: 'range',
        sourceValue: '198.51.0.0/16',
        sourceRange: '198.51.0.0/16',
      },
    ]);

    const results = await storage.queryAlerts({ sourceIp: '198.51.100.0/24' });

    expect(results.map((a) => a.sourceValue)).toEqual(['198.51.100.128/25', '198.51.100.0/24']);
  });

  it('lists the alerts of an IPv6 range whatever their textual form', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '2001:db8::1' },
      { receivedAt: at(2), sourceIp: '2001:0DB8:0000:0000:0000:0000:0000:0002' },
      { receivedAt: at(3), sourceIp: '2001:db9::1' },
      { receivedAt: at(4), sourceIp: '192.0.2.1' },
    ]);

    const results = await storage.queryAlerts({ sourceIp: '2001:db8::/32' });

    expect(results.map((a) => a.sourceIp)).toEqual([
      '2001:0DB8:0000:0000:0000:0000:0000:0002',
      '2001:db8::1',
    ]);
  });

  it('applies limit and offset to the matching alerts', async () => {
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ receivedAt: at(i * 2), sourceIp: `10.1.0.${i}` });
      rows.push({ receivedAt: at(i * 2 + 1), sourceIp: `10.1.200.${i}` }); // outside the /20
    }
    seed(rows);

    const page1 = await storage.queryAlerts({ sourceIp: '10.1.0.0/20', limit: 10 });
    const page2 = await storage.queryAlerts({ sourceIp: '10.1.0.0/20', limit: 10, offset: 10 });
    const last = await storage.queryAlerts({ sourceIp: '10.1.0.0/20', limit: 10, offset: 25 });
    const beyond = await storage.queryAlerts({ sourceIp: '10.1.0.0/20', limit: 10, offset: 30 });

    const expected = Array.from({ length: 30 }, (_, i) => `10.1.0.${29 - i}`);
    expect(page1.map((a) => a.sourceIp)).toEqual(expected.slice(0, 10));
    expect(page2.map((a) => a.sourceIp)).toEqual(expected.slice(10, 20));
    expect(last.map((a) => a.sourceIp)).toEqual(expected.slice(25));
    expect(beyond).toEqual([]);
  });

  it('pages through more candidates than one scan batch, with equal timestamps', async () => {
    // 1500 non-matching candidates (same prefilter octets) newer than the
    // matches, and every row received at the same instant: the scan must
    // continue past its first batch and order ties by id.
    const rows: SeedRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push({ receivedAt: at(0), sourceIp: `10.2.0.${i}` });
    }
    for (let i = 0; i < 1500; i++) {
      rows.push({ receivedAt: at(0), sourceIp: `10.2.${100 + (i % 100)}.${i % 250}` });
    }
    seed(rows);

    const page = await storage.queryAlerts({ sourceIp: '10.2.0.0/20', limit: 5, offset: 3 });
    const all = await storage.queryAlerts({ sourceIp: '10.2.0.0/20', limit: 100 });

    expect(all).toHaveLength(20);
    expect(all.map((a) => a.sourceIp)).toEqual(
      Array.from({ length: 20 }, (_, i) => `10.2.0.${19 - i}`)
    );
    expect(page.map((a) => a.id)).toEqual(all.slice(3, 8).map((a) => a.id));
  });

  it('intersects the range with the other filters', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '203.0.113.1', filtered: true },
      { receivedAt: at(2), sourceIp: '203.0.113.2', filtered: false },
      { receivedAt: at(3), sourceIp: '203.0.113.3', filtered: true, scenario: 'other/http' },
      { receivedAt: at(10), sourceIp: '203.0.113.4', filtered: true },
      { receivedAt: at(4), sourceIp: '198.51.100.1', filtered: true },
    ]);

    const results = await storage.queryAlerts({
      sourceIp: '203.0.113.0/24',
      filtered: true,
      scenario: 'ssh-bf',
      until: new Date(at(5)),
    });

    expect(results.map((a) => a.sourceIp)).toEqual(['203.0.113.1']);
  });

  it('bounds the scan', () => {
    expect(MAX_CIDR_SCAN_ROWS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('queryAlerts — country', () => {
  const storage = createStorage();

  it('filters on the source country and combines with the IP search', async () => {
    seed([
      { receivedAt: at(1), sourceIp: '203.0.113.1', geoCountryCode: 'FR' },
      { receivedAt: at(2), sourceIp: '203.0.113.2', geoCountryCode: 'DE' },
      { receivedAt: at(3), sourceIp: '198.51.100.3', geoCountryCode: 'FR' },
    ]);

    const fr = await storage.queryAlerts({ sourceCountry: 'FR' });
    const frInRange = await storage.queryAlerts({
      sourceCountry: 'FR',
      sourceIp: '203.0.113.0/24',
    });

    expect(fr.map((a) => a.sourceIp)).toEqual(['198.51.100.3', '203.0.113.1']);
    expect(frInRange.map((a) => a.sourceIp)).toEqual(['203.0.113.1']);
  });
});

describe('getStats — allCountries', () => {
  const storage = createStorage();

  it('lists every source country with its name and count, audit rows included', async () => {
    seed([
      { receivedAt: at(1), geoCountryCode: 'FR', geoCountryName: 'France' },
      { receivedAt: at(2), geoCountryCode: 'FR', geoCountryName: 'France' },
      { receivedAt: at(3), geoCountryCode: 'CN', geoCountryName: null },
      { receivedAt: at(4), geoCountryCode: 'FR', geoCountryName: 'France', localAudit: true },
      { receivedAt: at(5), geoCountryCode: null },
    ]);

    const stats = await storage.getStats();

    expect(stats.allCountries).toEqual([
      { country: 'FR', countryName: 'France', count: 3 },
      { country: 'CN', countryName: null, count: 1 },
    ]);
    // topCountries keeps excluding audit rows
    expect(stats.topCountries).toEqual([
      { country: 'FR', count: 2 },
      { country: 'CN', count: 1 },
    ]);
  });
});
