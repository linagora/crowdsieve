export interface AlertSource {
  scope: string;
  value: string;
  ip?: string;
  range?: string;
  as_number?: string;
  as_name?: string;
  cn?: string;
  latitude?: number;
  longitude?: number;
}

export interface AlertDecision {
  id?: number;
  uuid?: string;
  origin: string;
  type: string;
  scope: string;
  value: string;
  duration: string;
  scenario: string;
  simulated?: boolean;
  until?: string;
}

export interface StoredAlert {
  id: number;
  uuid?: string;
  machineId?: string;
  scenario: string;
  scenarioHash?: string;
  scenarioVersion?: string;
  message?: string;
  eventsCount?: number;
  startAt?: string;
  stopAt?: string;
  createdAt?: string;
  receivedAt: string;
  simulated: boolean;
  hasDecisions: boolean;
  sourceScope?: string;
  sourceValue?: string;
  sourceIp?: string;
  sourceCn?: string;
  geoCountryCode?: string;
  geoCountryName?: string;
  geoCity?: string;
  geoLatitude?: number;
  geoLongitude?: number;
  filtered: boolean;
  filterReasons?: string;
  forwardedToCapi: boolean;
}

export interface AlertStats {
  total: number;
  filtered: number;
  forwarded: number;
  topScenarios: Array<{ scenario: string; count: number }>;
  topCountries: Array<{ country: string; count: number }>;
  timeBounds: { min: string | null; max: string | null };
}

export interface WhoisSummary {
  netName?: string;
  netRange?: string;
  cidr?: string;
  organization?: string;
  country?: string;
  descr?: string;
  abuse?: string;
}

export interface IPInfo {
  ip: string;
  reverseDns: string[];
  whois: WhoisSummary | null;
  error?: string;
}

export interface LapiServer {
  name: string;
  url: string;
  canBan: boolean; // True if machine credentials are configured
}

export interface BanDecisionRequest {
  server: string;
  ip: string;
  duration: string;
  reason: string;
}

export interface BanDecisionResponse {
  success: boolean;
  message: string;
  server: string;
  error?: string;
  details?: string;
}

export interface Decision {
  id: number;
  origin: string;
  type: string;
  scope: string;
  value: string;
  duration: string;
  scenario: string;
  until?: string;
}

export interface ServerDecisions {
  server: string;
  decisions: Decision[];
  error?: string;
}

export interface DecisionSearchResponse {
  ip: string;
  results: ServerDecisions[];
  shared: Decision[]; // Decisions from CAPI/lists present on all servers
}

export interface TimeDistributionStats {
  byDayOfWeek: Array<{ day: number; dayName: string; count: number }>;
  byHourOfDay: Array<{ hour: number; count: number }>;
  byCountry: Array<{ countryCode: string; countryName: string; count: number }>;
  byScenario: Array<{ scenario: string; count: number }>;
  dailyTrend: Array<{ date: string; count: number }>;
  totalAlerts: number;
  dateRange: { from: string | null; to: string | null };
}

export interface DecisionStats {
  totalDecisions: number;
  byDayOfWeek: Array<{ day: number; dayName: string; count: number }>;
  byHourOfDay: Array<{ hour: number; count: number }>;
  byDurationCategory: Array<{ category: string; count: number }>;
  topScenarios: Array<{ scenario: string; count: number }>;
  byCountry: Array<{ countryCode: string; countryName: string; count: number }>;
}
