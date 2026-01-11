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
