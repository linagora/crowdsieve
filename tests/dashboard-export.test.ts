import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_EXPORT_COLUMNS,
  DECISION_EXPORT_COLUMNS,
  csvCell,
  decisionSearchExportRows,
  exportFileName,
  fetchAllPages,
  serializeExport,
  toCsv,
  toJson,
  type ExportColumn,
} from '../dashboard/lib/export.js';
import type { DecisionSearchResponse, StoredAlert } from '../dashboard/lib/types.js';

/** Minimal RFC 4180 parser, to check the CSV round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += c;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('csvCell', () => {
  it('quotes cells with commas, quotes or line breaks (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\r')).toBe('"cr\r"');
  });

  it('writes empty cells for missing values and plain numbers and booleans', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
  });

  it('neutralises text a spreadsheet would read as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+33 1 23')).toBe("'+33 1 23");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe('"\'\rcmd"');
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell('a=1')).toBe('a=1');
  });
});

describe('toCsv', () => {
  const columns: ExportColumn<{ a: string; b: number }>[] = [
    { header: 'a', value: (r) => r.a },
    { header: 'b', value: (r) => r.b },
  ];

  it('writes a header row and one CRLF-terminated line per row', () => {
    expect(toCsv([{ a: 'x', b: 1 }], columns)).toBe('a,b\r\nx,1\r\n');
    expect(toCsv([], columns)).toBe('a,b\r\n');
  });

  it('round-trips awkward values through an RFC 4180 parser', () => {
    const rows = [{ a: 'multi\r\nline, "quoted"', b: 2 }];
    expect(parseCsv(toCsv(rows, columns))).toEqual([
      ['a', 'b'],
      ['multi\r\nline, "quoted"', '2'],
    ]);
  });
});

describe('toJson / serializeExport', () => {
  it('writes the rows as a JSON array', () => {
    const rows = [{ id: 1, message: '=cmd' }];
    expect(JSON.parse(toJson(rows))).toEqual(rows);
    expect(JSON.parse(serializeExport(rows, [], 'json'))).toEqual(rows);
  });
});

describe('exportFileName', () => {
  it('stamps the local date and time', () => {
    const date = new Date(2026, 10, 3, 9, 5);
    expect(exportFileName('crowdsieve-alerts', 'csv', date)).toBe(
      'crowdsieve-alerts-20261103-0905.csv'
    );
    expect(exportFileName('crowdsieve-decisions', 'json', date)).toBe(
      'crowdsieve-decisions-20261103-0905.json'
    );
  });
});

describe('fetchAllPages', () => {
  function source(total: number) {
    const rows = Array.from({ length: total }, (_, i) => i);
    return vi.fn(async (offset: number, limit: number) => rows.slice(offset, offset + limit));
  }

  it('fetches every page until a short one', async () => {
    const fetchPage = source(250);
    const progress: number[] = [];
    const result = await fetchAllPages(fetchPage, {
      pageSize: 100,
      maxRows: 1000,
      onProgress: (n) => progress.push(n),
    });
    expect(result.rows).toHaveLength(250);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(progress).toEqual([100, 200, 250]);
  });

  it('stops at maxRows and reports truncation', async () => {
    const fetchPage = source(1500);
    const result = await fetchAllPages(fetchPage, { pageSize: 400, maxRows: 1000 });
    expect(result.rows).toHaveLength(1000);
    expect(result.rows[999]).toBe(999);
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when exactly maxRows exist', async () => {
    const fetchPage = source(1000);
    const result = await fetchAllPages(fetchPage, { pageSize: 500, maxRows: 1000 });
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(false);
    // the last request only asks for the one row that would prove truncation
    expect(fetchPage.mock.calls.at(-1)).toEqual([1000, 1]);
  });

  it('propagates fetch errors', async () => {
    await expect(
      fetchAllPages(
        async () => {
          throw new Error('Failed to fetch alerts (HTTP 500)');
        },
        { pageSize: 10, maxRows: 100 }
      )
    ).rejects.toThrow('HTTP 500');
  });
});

describe('alert export columns', () => {
  const alert = {
    id: 7,
    receivedAt: '2026-11-03T09:05:00.000Z',
    scenario: 'crowdsecurity/ssh-bf',
    sourceIp: '203.0.113.7',
    sourceRange: '203.0.113.0/24',
    geoCountryCode: 'FR',
    machineId: 'srv-01',
    eventsCount: 5,
    hasDecisions: true,
    filtered: true,
    filterReasons: '["internal range","no decision"]',
    forwardedToCapi: false,
    simulated: false,
    replicated: false,
    actor: 'alice',
    message: '=cmd|"/c calc"!A1',
  } as StoredAlert;

  it('writes the documented columns, in order', () => {
    const [header, row] = parseCsv(toCsv([alert], ALERT_EXPORT_COLUMNS));
    expect(header).toEqual([
      'id',
      'received_at',
      'scenario',
      'source_ip',
      'source_range',
      'country',
      'machine',
      'events_count',
      'has_decision',
      'filtered',
      'filter_reasons',
      'forwarded_to_capi',
      'simulated',
      'actor',
      'message',
    ]);
    expect(row).toEqual([
      '7',
      '2026-11-03T09:05:00.000Z',
      'crowdsecurity/ssh-bf',
      '203.0.113.7',
      '203.0.113.0/24',
      'FR',
      'srv-01',
      '5',
      'true',
      'true',
      'internal range; no decision',
      'false',
      'false',
      'alice',
      `'=cmd|"/c calc"!A1`,
    ]);
  });

  it('converts timestamps to UTC ISO 8601 and keeps raw filter reasons', () => {
    const [, row] = parseCsv(
      toCsv(
        [{ ...alert, receivedAt: '2026-11-03 10:05:00+01:00', filterReasons: 'legacy' }],
        ALERT_EXPORT_COLUMNS
      )
    );
    expect(row[1]).toBe('2026-11-03T09:05:00.000Z');
    expect(row[10]).toBe('legacy');
  });
});

describe('decision search export', () => {
  const response: DecisionSearchResponse = {
    ip: '203.0.113.7',
    shared: [
      {
        id: 1,
        origin: 'CAPI',
        type: 'ban',
        scope: 'Ip',
        value: '203.0.113.7',
        duration: '100h',
        scenario: 'crowdsecurity/ssh-bf',
      },
    ],
    results: [
      {
        server: 'lapi-1',
        decisions: [
          {
            id: 42,
            origin: 'crowdsec',
            type: 'ban',
            scope: 'Ip',
            value: '203.0.113.7',
            duration: '3h59m',
            scenario: 'crowdsecurity/http-probing',
            until: '2026-11-03T13:05:00Z',
          },
        ],
      },
      { server: 'lapi-2', decisions: [], error: 'timeout' },
    ],
  };

  it('lists every decision with its server and expiry', () => {
    const rows = parseCsv(toCsv(decisionSearchExportRows(response), DECISION_EXPORT_COLUMNS));
    expect(rows).toEqual([
      ['server', 'id', 'type', 'scope', 'value', 'origin', 'scenario', 'duration', 'until'],
      ['shared', '1', 'ban', 'Ip', '203.0.113.7', 'CAPI', 'crowdsecurity/ssh-bf', '100h', ''],
      [
        'lapi-1',
        '42',
        'ban',
        'Ip',
        '203.0.113.7',
        'crowdsec',
        'crowdsecurity/http-probing',
        '3h59m',
        '2026-11-03T13:05:00.000Z',
      ],
    ]);
  });
});
