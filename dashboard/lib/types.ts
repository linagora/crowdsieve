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
  sourceRange?: string;
  sourceCn?: string;
  geoCountryCode?: string;
  geoCountryName?: string;
  geoCity?: string;
  geoLatitude?: number;
  geoLongitude?: number;
  filtered: boolean;
  filterReasons?: string;
  /** JSON array of the names of the filter rules the alert matched (null for older alerts). */
  filterRules?: string | null;
  forwardedToCapi: boolean;
  replicated: boolean;
  /**
   * True for locally-recorded audit rows (unban, manual-ban audit). The
   * specific kind is identified by `scenario` (`crowdsieve/unban` or
   * `crowdsieve/manual-audit`).
   */
  localAudit?: boolean;
  actor?: string;
  /** Audit rows only: LAPI server, remediation type and duration of a manual ban. */
  auditServer?: string | null;
  auditType?: string | null;
  auditDuration?: string | null;
}

/** A decision stored for an alert (alert detail). */
export interface AlertDetailDecision {
  id: number;
  type: string;
  scope: string;
  value: string;
  duration: string | null;
  origin: string | null;
  scenario: string | null;
  until: string | null;
  simulated: boolean | null;
}

/** An event of an alert; meta keys and values are attacker-controlled text. */
export interface AlertDetailEvent {
  timestamp: string | null;
  meta: Array<{ key: string; value: string }>;
}

/** `GET /api/alerts/:id`: the alert plus its decisions and first events. */
export interface AlertDetail extends StoredAlert {
  rawJson?: string | null;
  decisions: AlertDetailDecision[];
  events: AlertDetailEvent[];
  eventsTotal: number;
}

export interface AlertStats {
  total: number;
  filtered: number;
  forwarded: number;
  /**
   * Sum of `droppedItems` across every `componentKind='remediation'`
   * bouncer_metrics snapshot in the retention window. CrowdSec emits
   * `dropped` as a per-window counter (one block per `WindowSizeSeconds`),
   * so a plain sum gives the total dropped requests over the window.
   * 0 when bouncer metrics are disabled or no data is available.
   */
  blockedRequests: number;
  /** Top 10 scenarios for the stats panel — excludes audit-only rows. */
  topScenarios: Array<{ scenario: string; count: number }>;
  /**
   * Distinct scenarios for the filter dropdown. Uncapped, includes audit-only
   * rows (`crowdsieve/unban`, `crowdsieve/manual-audit`, `crowdsieve/manual`).
   */
  allScenarios: Array<{ scenario: string; count: number }>;
  topCountries: Array<{ country: string; count: number }>;
  /**
   * Distinct source countries for the country filter dropdown (ISO code,
   * GeoIP name when known), including audit-only rows.
   */
  allCountries: Array<{ country: string; countryName: string | null; count: number }>;
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

export interface ActiveDecisionsServerResult extends ServerDecisions {
  /** More decisions matched than the proxy returns per server. */
  truncated?: boolean;
  /** Number of matching decisions before the cap, when truncated. */
  total?: number;
}

export interface ActiveDecisionsResponse {
  results: ActiveDecisionsServerResult[];
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

/**
 * Single snapshot of bouncer usage-metrics, mirroring the backend
 * BouncerMetricResponse schema (src/proxy/routes/schemas.ts).
 */
export interface BouncerMetric {
  id: number;
  lapiServerName: string;
  componentKind: string;
  bouncerName: string;
  bouncerType: string | null;
  osName: string | null;
  osVersion: string | null;
  version: string | null;
  activeDecisions: number | null;
  processedItems: number | null;
  droppedItems: number | null;
  bytesProcessed: number | null;
  collectedAt: number;
  metricsJson: string;
}

export interface BouncerName {
  lapiServerName: string;
  bouncerName: string;
  bouncerType: string | null;
  /** Unix ms of the last usage-metrics report. */
  lastSeenAt: number;
  version: string | null;
  osName: string | null;
  osVersion: string | null;
}

export type AuditAction = 'ban' | 'unban';

/** One manual ban or unban of the audit log (GET /api/audit). */
export interface AuditLogItem {
  /** Id of the audit row, shown by the alert detail page. */
  id: number;
  at: string;
  action: AuditAction;
  actor: string | null;
  ip: string | null;
  server: string | null;
  /** Remediation type of a ban (`ban`, `captcha`); null for unbans. */
  type: string | null;
  /** Duration of a ban (e.g. `4h`); null for unbans. */
  duration: string | null;
  reason: string | null;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  total: number;
}
