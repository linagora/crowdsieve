/** Shape of the proxy's GET /api/status answer (see src/status/index.ts). */
export interface StatusProblem {
  kind: 'capi' | 'lapi';
  server?: string;
  since: number | null;
  message: string;
}

export interface CapiStatus {
  enabled: boolean;
  state: 'disabled' | 'idle' | 'ok' | 'failing';
  lastSuccessAt: number | null;
  lastError: { at: number; message: string } | null;
  failingSince: number | null;
  sent24h: number;
  failed24h: number;
}

export interface LapiStatus {
  name: string;
  host: string;
  reachable: boolean | null;
  responseTimeMs: number | null;
  error: string | null;
  checkedAt: number | null;
  unreachableSince: number | null;
  machineCredentials: boolean;
  machineAuth: 'not_configured' | 'ok' | 'failed' | 'unknown';
  manualBanAvailable: boolean;
  replication: {
    enabled: boolean;
    lastError: { at: number; message: string } | null;
    lastSuccessAt: number | null;
  };
}

export interface StatusSnapshot {
  ok: boolean;
  problems: StatusProblem[];
  capi: CapiStatus;
  lapis: LapiStatus[];
  generatedAt: number;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One-line text of the global banner for a problem. */
export function bannerMessage(problem: StatusProblem): string {
  if (problem.kind === 'capi') {
    return problem.since
      ? `CAPI forwarding is failing since ${hhmm(problem.since)}`
      : 'CAPI forwarding is failing';
  }
  return `LAPI ${problem.server ?? '(unknown)'} is unreachable`;
}

/** "All systems operational" / "2 problems". */
export function summaryLabel(status: Pick<StatusSnapshot, 'problems'>): string {
  const n = status.problems.length;
  if (n === 0) return 'All systems operational';
  return `${n} problem${n > 1 ? 's' : ''}`;
}
