import type { LokiSource, SourceRef, Extraction } from '../config.js';

export interface LogEntry {
  raw: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export interface FetchLogsResult {
  logs: LogEntry[];
  error?: string;
}

/**
 * Get a nested field value from an object using dot notation
 * e.g., getNestedValue({ mdc: { remoteIP: "1.2.3.4" } }, "mdc.remoteIP") => "1.2.3.4"
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Extract configured fields from a parsed JSON log entry
 */
function extractFields(parsed: unknown, extraction: Extraction): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [outputField, sourcePath] of Object.entries(extraction.fields)) {
    result[outputField] = getNestedValue(parsed, sourcePath);
  }

  return result;
}

/**
 * Fetch logs from Grafana/Loki
 *
 * Uses the Grafana /api/ds/query endpoint which works with the Loki datasource
 */
export async function fetchLogs(
  source: LokiSource,
  sourceRef: SourceRef,
  extraction: Extraction,
  lookback: string,
  timeoutMs: number = 30000
): Promise<FetchLogsResult> {
  const queryPayload = {
    queries: [
      {
        refId: 'A',
        datasource: {
          uid: source.datasource_uid,
          type: 'loki',
        },
        expr: sourceRef.query,
        maxLines: sourceRef.max_lines,
      },
    ],
    from: `now-${lookback}`,
    to: 'now',
  };

  try {
    const response = await fetch(`${source.grafana_url}/api/ds/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${source.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'crowdsieve-analyzer/1.0',
      },
      body: JSON.stringify(queryPayload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        logs: [],
        error: `Grafana API error ${response.status}: ${errorText}`,
      };
    }

    const data = (await response.json()) as {
      message?: string;
      results?: {
        A?: {
          error?: string;
          frames?: Array<{
            data?: {
              values?: [number[], unknown[], string[]];
            };
          }>;
        };
      };
    };

    // Check for errors in the response
    if (data.message) {
      return {
        logs: [],
        error: `Grafana error: ${data.message}`,
      };
    }

    if (data.results?.A?.error) {
      return {
        logs: [],
        error: `Loki error: ${data.results.A.error}`,
      };
    }

    // Extract log lines from Loki response
    // Format: results.A.frames[0].data.values[2] contains the log lines
    const frames = data.results?.A?.frames || [];
    if (frames.length === 0) {
      return { logs: [] };
    }

    const logLines: string[] = frames[0]?.data?.values?.[2] || [];
    const timestamps: number[] = frames[0]?.data?.values?.[0] || [];

    const logs: LogEntry[] = [];

    for (let i = 0; i < logLines.length; i++) {
      const raw = logLines[i];
      const timestamp = timestamps[i]
        ? new Date(timestamps[i] / 1000000).toISOString() // Loki returns nanoseconds
        : new Date().toISOString();

      // Parse JSON log if format is json
      if (extraction.format === 'json') {
        try {
          const parsed = JSON.parse(raw);
          const fields = extractFields(parsed, extraction);
          logs.push({ raw, timestamp, fields });
        } catch {
          // Skip malformed JSON lines
          continue;
        }
      } else {
        logs.push({ raw, timestamp, fields: {} });
      }
    }

    return { logs };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { logs: [], error: 'Request timeout' };
    }
    return {
      logs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
