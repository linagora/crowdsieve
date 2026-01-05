/**
 * CrowdSec Alert and Decision types
 * Based on CrowdSec CAPI/LAPI Swagger specification
 */

export interface Source {
  scope: string; // "ip", "range", "username", etc.
  value: string; // The actual value
  ip?: string; // Convenience field for IP sources
  range?: string; // Convenience field for ranges
  as_number?: string; // AS number
  as_name?: string; // AS name
  cn?: string; // Country code (2 letters)
  latitude?: number;
  longitude?: number;
}

export interface Decision {
  id?: number;
  uuid?: string;
  origin: string; // "crowdsec", "cscli", "capi", "lists"
  type: string; // "ban", "captcha", "throttle", etc.
  scope: string; // "ip", "range", "username"
  value: string; // The scope value
  duration: string; // Duration string, e.g., "4h"
  until?: string; // Expiration timestamp
  scenario: string;
  simulated?: boolean;
}

export interface EventMeta {
  key: string;
  value: string;
}

export interface Event {
  timestamp: string;
  meta: EventMeta[];
}

export interface Alert {
  id?: number;
  uuid?: string;
  machine_id?: string;
  created_at?: string;
  scenario: string;
  scenario_hash: string;
  scenario_version: string;
  message: string;
  events_count: number;
  start_at: string;
  stop_at: string;
  capacity: number;
  leakspeed: string;
  simulated: boolean;
  events: Event[];
  remediation?: boolean;
  decisions?: Decision[];
  source: Source;
  meta?: EventMeta[];
  labels?: string[];
}

// Request body for POST /v2/signals
export type SignalsRequest = Alert[];

// Response from POST /v2/signals
export interface SignalsResponse {
  message?: string;
}

// GeoIP enrichment data
export interface GeoIPInfo {
  countryCode?: string;
  countryName?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  org?: string;
}

// Stored alert with additional metadata
export interface StoredAlert extends Alert {
  receivedAt: string;
  filtered: boolean;
  filterReasons?: string[];
  geoip?: GeoIPInfo;
}
