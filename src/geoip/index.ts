import { Reader } from '@maxmind/geoip2-node';
import { existsSync } from 'fs';
import pino from 'pino';
import type { GeoIPInfo } from '../models/alert.js';

const logger = pino({ name: 'geoip' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reader: any = null;

export async function initGeoIP(dbPath: string): Promise<boolean> {
  if (!existsSync(dbPath)) {
    logger.warn({ path: dbPath }, 'GeoIP database not found');
    return false;
  }

  try {
    reader = await Reader.open(dbPath);
    logger.info('GeoIP database loaded successfully');
    return true;
  } catch (error) {
    logger.error({ error }, 'Failed to load GeoIP database');
    return false;
  }
}

export function lookupIP(ip: string): GeoIPInfo | null {
  if (!reader) {
    return null;
  }

  try {
    const response = reader.city(ip);
    return {
      countryCode: response.country?.isoCode,
      countryName: response.country?.names?.en,
      city: response.city?.names?.en,
      region: response.subdivisions?.[0]?.names?.en,
      latitude: response.location?.latitude,
      longitude: response.location?.longitude,
      timezone: response.location?.timeZone,
    };
  } catch {
    // IP not found in database or invalid IP
    return null;
  }
}

export function closeGeoIP(): void {
  reader = null;
}

export function isGeoIPAvailable(): boolean {
  return reader !== null;
}
