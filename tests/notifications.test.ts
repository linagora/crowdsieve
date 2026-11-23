/**
 * Notification service (src/notifications): configuration, payloads, Slack
 * escaping, alert matching, grouping into digests, retries, bounded memory,
 * status events, test messages and shutdown. Timers and fetch are injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, type NotificationsConfig } from '../src/config/index.js';
import {
  alertMatches,
  buildSlackText,
  buildWebhookPayload,
  createNotificationService,
  escapeSlack,
  MAX_BUFFERED_ITEMS,
  MAX_OUTBOX_MESSAGES,
  slackCode,
  TEST_COOLDOWN_MS,
  type NotificationDigest,
  type NotificationTimers,
} from '../src/notifications/index.js';
import type { StoredAlertSummary } from '../src/storage/index.js';

const DASHBOARD = 'https://crowdsieve.example.com';
const HOOK_URL = 'https://hooks.example.test/services/T000/B000/SECRETPATH?token=QUERYSECRET';
const HEADER_SECRET = 'Bearer header-SECRET-value';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(start = Date.UTC(2026, 10, 23, 10, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    set: (value: number) => {
      t = value;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic timers: callbacks run when `advance` reaches their time. */
function makeTimers(clock: ReturnType<typeof makeClock>) {
  let seq = 0;
  const pending: Array<{ id: number; at: number; fn: () => void }> = [];
  const timers: NotificationTimers = {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.push({ id, at: clock.now() + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      const i = pending.findIndex((p) => p.id === handle);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  async function advance(ms: number): Promise<void> {
    const end = clock.now() + ms;
    await settle();
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > end) break;
      pending.shift();
      clock.set(next.at);
      next.fn();
      await settle();
    }
    clock.set(end);
    await settle();
  }
  return { timers, pending, advance };
}

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

type Target = NotificationsConfig['targets'][number];

function target(overrides: Partial<Target> = {}): Target {
  return {
    name: 'hook',
    type: 'webhook',
    url: HOOK_URL,
    headers: { Authorization: HEADER_SECRET },
    events: ['alert', 'manual_ban', 'unban', 'forwarding_error', 'lapi_error'],
    match: { scenarios: [], countries: [], machines: [], status: 'forwarded' },
    min_interval: '5m',
    ...overrides,
  };
}

function setup(
  targets: Target[] = [target()],
  respond: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 })
) {
  const clock = makeClock();
  const { timers, pending, advance } = makeTimers(clock);
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {})
  );
  const logger = silentLogger();
  const service = createNotificationService({ dashboard_url: DASHBOARD, targets }, logger, {
    now: clock.now,
    timers,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const bodies = () =>
    fetchImpl.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  return { service, clock, timers, pending, advance, fetchImpl, logger, bodies };
}

let nextId = 1;
function storedAlert(overrides: Partial<StoredAlertSummary> = {}): StoredAlertSummary {
  const id = nextId++;
  return {
    index: 0,
    id,
    scenario: 'crowdsecurity/ssh-bf',
    ip: '203.0.113.7',
    country: 'FR',
    machineId: 'qa-agent',
    filtered: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('notifications configuration', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crowdsieve-notif-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  function load(yaml: string) {
    const file = join(dir, 'filters.yaml');
    writeFileSync(file, `proxy: {}\nstorage: {}\n${yaml}`);
    return loadConfig(file);
  }

  it('is empty by default', () => {
    expect(load('').notifications).toEqual({ targets: [] });
  });

  it('parses targets with defaults and interpolates env vars in headers', () => {
    process.env.HOOK_TOKEN = 'from-env';
    const config = load(`
notifications:
  dashboard_url: "https://crowdsieve.example.com/"
  targets:
    - name: soc
      type: slack
      url: "https://chat.example.com/hooks/abc"
      events: [alert, alert, manual_ban]
    - name: incidents
      type: webhook
      url: "http://incidents.example.com/hook"
      headers:
        Authorization: "Bearer \${HOOK_TOKEN}"
      events: [lapi_error]
      match:
        scenarios: [ssh-bf]
        countries: [fr]
        status: any
      min_interval: 1h30m
`);
    expect(config.notifications.dashboard_url).toBe('https://crowdsieve.example.com');
    const [soc, incidents] = config.notifications.targets;
    expect(soc).toMatchObject({
      events: ['alert', 'manual_ban'],
      headers: {},
      min_interval: '5m',
      match: { scenarios: [], countries: [], machines: [], status: 'forwarded' },
    });
    expect(incidents.headers).toEqual({ Authorization: 'Bearer from-env' });
    expect(incidents.match).toEqual({
      scenarios: ['ssh-bf'],
      countries: ['FR'],
      machines: [],
      status: 'any',
    });
    expect(incidents.min_interval).toBe('1h30m');
  });

  const invalid: Array<[string, string, RegExp]> = [
    ['a non-http scheme', 'url: "ftp://example.com/x"', /http/],
    ['URL credentials', 'url: "https://user:pass@example.com/x"', /credentials/],
    ['an unknown event', 'url: "https://example.com/x"\n      events: [alerts]', /events/],
    [
      'a bad min_interval',
      'url: "https://example.com/x"\n      min_interval: 5 minutes',
      /Go duration/,
    ],
    [
      'an unknown key',
      'url: "https://example.com/x"\n      evnets: [alert]',
      /evnets|Unrecognized/,
    ],
    [
      'a header with a line break',
      'url: "https://example.com/x"\n      headers: { X-Token: "a\\r\\nInjected: 1" }',
      /line breaks/,
    ],
    [
      'a reserved header',
      'url: "https://example.com/x"\n      headers: { Content-Type: text/plain }',
      /cannot set/,
    ],
  ];

  for (const [label, line, error] of invalid) {
    it(`rejects ${label}`, () => {
      const events = line.includes('events:') ? '' : '\n      events: [alert]';
      expect(() =>
        load(`
notifications:
  targets:
    - name: t
      type: webhook
      ${line}${events}
`)
      ).toThrow(error);
    });
  }

  it('rejects duplicate target names and invalid names', () => {
    expect(() =>
      load(`
notifications:
  targets:
    - { name: a, type: webhook, url: "https://e.com/1", events: [alert] }
    - { name: a, type: slack, url: "https://e.com/2", events: [unban] }
`)
    ).toThrow(/unique/);
    expect(() =>
      load(`
notifications:
  targets:
    - { name: "a b", type: webhook, url: "https://e.com/1", events: [alert] }
`)
    ).toThrow(/letters/);
  });

  it('rejects an empty URL left by an unset env var', () => {
    delete process.env.MISSING_HOOK_URL;
    expect(() =>
      load(`
notifications:
  targets:
    - { name: a, type: webhook, url: "\${MISSING_HOOK_URL}", events: [alert] }
`)
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

describe('Slack escaping', () => {
  it('escapes &, < and >', () => {
    expect(escapeSlack('a & <b> <!channel>')).toBe('a &amp; &lt;b&gt; &lt;!channel&gt;');
  });

  it('renders untrusted values as inline code without breakout', () => {
    expect(slackCode('<!channel> @here [x](https://evil.test)')).toBe(
      '`&lt;!channel&gt; @here [x](https://evil.test)`'
    );
    expect(slackCode('a`b\nc\u2028d')).toBe("`a'b c d`");
    expect(slackCode('')).toBe('`unknown`');
    expect(slackCode('x'.repeat(500)).length).toBeLessThan(210);
  });
});

describe('alertMatches', () => {
  const match = (m: Partial<Target['match']>) => ({
    scenarios: [],
    countries: [],
    machines: [],
    status: 'forwarded' as const,
    ...m,
  });
  const alert = {
    scenario: 'crowdsecurity/SSH-bf',
    country: 'fr',
    machine: 'QA-agent',
    filtered: false,
  };

  it('matches scenario substrings, countries and machines case-insensitively', () => {
    expect(alertMatches(match({ scenarios: ['ssh-bf'] }), alert)).toBe(true);
    expect(alertMatches(match({ scenarios: ['http'] }), alert)).toBe(false);
    expect(alertMatches(match({ countries: ['FR'] }), alert)).toBe(true);
    expect(alertMatches(match({ countries: ['DE'] }), alert)).toBe(false);
    expect(alertMatches(match({ machines: ['qa-agent'] }), alert)).toBe(true);
    expect(alertMatches(match({ machines: ['other'] }), alert)).toBe(false);
  });

  it('applies the status (forwarded by default)', () => {
    const filtered = { ...alert, filtered: true };
    expect(alertMatches(match({}), filtered)).toBe(false);
    expect(alertMatches(match({ status: 'filtered' }), filtered)).toBe(true);
    expect(alertMatches(match({ status: 'filtered' }), alert)).toBe(false);
    expect(alertMatches(match({ status: 'any' }), filtered)).toBe(true);
  });
});

describe('message formats', () => {
  const at = Date.UTC(2026, 10, 23, 10, 0, 0);
  const alertItem = (id: number, scenario = 'crowdsecurity/ssh-bf') => ({
    kind: 'alert' as const,
    occurredAt: at,
    id,
    scenario,
    ip: '203.0.113.7',
    country: 'FR',
    machine: 'qa-agent',
    filtered: false,
  });

  it('builds the JSON webhook payload', () => {
    const digest: NotificationDigest = {
      event: 'alert',
      items: [alertItem(12)],
      total: 1,
      groups: new Map([['crowdsecurity/ssh-bf', 1]]),
    };
    expect(buildWebhookPayload(digest, DASHBOARD)).toEqual({
      event: 'alert',
      occurred_at: '2026-11-23T10:00:00.000Z',
      crowdsieve_url: DASHBOARD,
      total: 1,
      omitted: 0,
      summary: [{ key: 'crowdsecurity/ssh-bf', count: 1 }],
      items: [
        {
          occurred_at: '2026-11-23T10:00:00.000Z',
          id: 12,
          scenario: 'crowdsecurity/ssh-bf',
          ip: '203.0.113.7',
          country: 'FR',
          machine: 'qa-agent',
          filtered: false,
          link: `${DASHBOARD}/alerts/12`,
        },
      ],
    });
  });

  it('writes one Slack line per alert, with its link', () => {
    const text = buildSlackText(
      {
        event: 'alert',
        items: [alertItem(12)],
        total: 1,
        groups: new Map([['crowdsecurity/ssh-bf', 1]]),
      },
      DASHBOARD
    );
    expect(text).toBe(
      `🚨 \`crowdsecurity/ssh-bf\` from 203.0.113.7 (FR) on \`qa-agent\` — ${DASHBOARD}/alerts/12`
    );
  });

  it('shows the first alert and a digest of the others', () => {
    const items = [
      alertItem(1),
      ...Array.from({ length: 8 }, (_, i) => alertItem(i + 2)),
      ...Array.from({ length: 3 }, (_, i) => alertItem(i + 10, 'crowdsecurity/http-probing')),
    ];
    const text = buildSlackText(
      {
        event: 'alert',
        items,
        total: 12,
        groups: new Map([
          ['crowdsecurity/ssh-bf', 9],
          ['crowdsecurity/http-probing', 3],
        ]),
      },
      DASHBOARD
    );
    expect(text.split('\n')).toEqual([
      `🚨 \`crowdsecurity/ssh-bf\` from 203.0.113.7 (FR) on \`qa-agent\` — ${DASHBOARD}/alerts/1`,
      `➕ 11 more alerts: \`crowdsecurity/ssh-bf\` ×8, \`crowdsecurity/http-probing\` ×3 — ${DASHBOARD}/alerts`,
    ]);
  });

  it('writes manual bans and unbans', () => {
    const ban = {
      kind: 'manual_ban' as const,
      occurredAt: at,
      actor: 'alice@example.com',
      ip: '198.51.100.240',
      scope: 'ip' as const,
      type: 'ban' as const,
      duration: '1h',
      server: 'lapi-qa',
      reason: 'abuse <@U123> *bold*',
      auditId: 7,
    };
    expect(
      buildSlackText({ event: 'manual_ban', items: [ban], total: 1, groups: new Map() }, DASHBOARD)
    ).toBe(
      `🔒 \`alice@example.com\` banned 198.51.100.240 on lapi-qa for 1h: \`abuse &lt;@U123&gt; *bold*\` — ${DASHBOARD}/alerts/7`
    );
    const unban = {
      kind: 'unban' as const,
      occurredAt: at,
      actor: null,
      ip: '198.51.100.0/24',
      scope: 'range' as const,
      server: 'lapi-qa',
      reason: 'false positive',
      decisionId: 42,
      auditId: null,
    };
    expect(
      buildSlackText({ event: 'unban', items: [unban], total: 1, groups: new Map() }, null)
    ).toBe(
      '🔓 `unknown user` unbanned 198.51.100.0/24 on lapi-qa (decision #42): `false positive`'
    );
  });

  it('never lets attacker-controlled alert fields out of a code span', () => {
    const text = buildSlackText(
      {
        event: 'alert',
        items: [
          {
            ...alertItem(5, 'x` <!channel> [click](https://evil.test) @all'),
            ip: '<https://evil.test|1.2.3.4>',
            country: '<!here>',
            machine: '`@channel`',
          },
        ],
        total: 1,
        groups: new Map(),
      },
      DASHBOARD
    );
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    // Every untrusted value sits in a code span: removing the spans leaves no
    // link, mention or markup.
    const outside = text.replace(/`[^`]*`/g, '');
    expect(outside).toBe(` 🚨  from  on  — ${DASHBOARD}/alerts/5`.trimStart());
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

describe('alert notifications', () => {
  it('sends one JSON POST for a matching alert, with headers and without following redirects', async () => {
    const { service, advance, fetchImpl, bodies } = setup([
      target({
        events: ['alert'],
        match: { scenarios: ['ssh-bf'], countries: [], machines: [], status: 'forwarded' },
      }),
    ]);
    const alert = storedAlert();
    service.notifyAlerts([alert, storedAlert({ scenario: 'crowdsecurity/http-probing' })]);
    expect(fetchImpl).not.toHaveBeenCalled(); // asynchronous
    await advance(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(HOOK_URL);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({
      Authorization: HEADER_SECRET,
      'Content-Type': 'application/json',
    });
    expect(bodies()[0]).toMatchObject({
      event: 'alert',
      crowdsieve_url: DASHBOARD,
      total: 1,
      items: [
        {
          id: alert.id,
          scenario: 'crowdsecurity/ssh-bf',
          ip: '203.0.113.7',
          link: `${DASHBOARD}/alerts/${alert.id}`,
        },
      ],
    });
  });

  it('sends nothing for a filtered alert when status is forwarded', async () => {
    const { service, advance, fetchImpl } = setup([target({ events: ['alert'] })]);
    service.notifyAlerts([storedAlert({ filtered: true })]);
    await advance(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores the crowdsieve/manual alerts of manual bans', async () => {
    const { service, advance, fetchImpl } = setup([target({ events: ['alert'] })]);
    service.notifyAlerts([storedAlert({ scenario: 'crowdsieve/manual' })]);
    await advance(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('groups ten alerts of one batch into one message', async () => {
    const { service, advance, fetchImpl, bodies } = setup([target({ events: ['alert'] })]);
    service.notifyAlerts(Array.from({ length: 10 }, () => storedAlert()));
    await advance(10 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({ total: 10, omitted: 0 });
    expect(bodies()[0].items).toHaveLength(10);
  });

  it('sends the first alert, then one digest of the others at the end of min_interval', async () => {
    const { service, advance, fetchImpl, bodies } = setup([
      target({ type: 'slack', events: ['alert'], min_interval: '5m' }),
    ]);
    service.notifyAlerts([storedAlert()]);
    await advance(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Nine more within the interval: nothing sent until it ends.
    for (let i = 0; i < 9; i++) {
      service.notifyAlerts([storedAlert(i < 6 ? {} : { scenario: 'crowdsecurity/http-probing' })]);
      await advance(20_000);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await advance(5 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const digest = bodies()[1].text as string;
    expect(digest).toContain(
      '➕ 8 more alerts: `crowdsecurity/ssh-bf` ×5, `crowdsecurity/http-probing` ×3'
    );

    // Quiet afterwards: no further message.
    await advance(30 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends each event on its own with min_interval 0', async () => {
    const { service, advance, fetchImpl } = setup([
      target({ events: ['alert'], min_interval: '0' }),
    ]);
    service.notifyAlerts([storedAlert()]);
    await advance(1_000);
    service.notifyAlerts([storedAlert()]);
    await advance(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps memory bounded: at most MAX_BUFFERED_ITEMS items, all counted', async () => {
    const { service, advance, bodies, logger } = setup([target({ events: ['alert'] })]);
    service.notifyAlerts(Array.from({ length: MAX_BUFFERED_ITEMS + 50 }, () => storedAlert()));
    await advance(1_000);
    const body = bodies()[0];
    expect(body.total).toBe(MAX_BUFFERED_ITEMS + 50);
    expect(body.items).toHaveLength(MAX_BUFFERED_ITEMS);
    expect(body.omitted).toBe(50);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'hook', event: 'alert' }),
      expect.stringContaining('dropping the oldest events')
    );
  });
});

describe('ban, unban and status events', () => {
  it('sends manual_ban and unban events with actor, IP, server, duration and reason', async () => {
    const { service, advance, bodies } = setup([target({ events: ['manual_ban', 'unban'] })]);
    service.notifyManualBan({
      actor: 'alice@example.com',
      ip: '198.51.100.240',
      scope: 'ip',
      type: 'ban',
      duration: '1h',
      server: 'lapi-qa',
      reason: 'abuse',
      auditId: 3,
    });
    service.notifyUnban({
      actor: 'bob@example.com',
      ip: '198.51.100.240',
      scope: 'ip',
      server: 'lapi-qa',
      reason: 'false positive',
      decisionId: 42,
      auditId: 4,
    });
    await advance(1_000);
    const [ban, unban] = bodies();
    expect(ban).toMatchObject({
      event: 'manual_ban',
      items: [
        {
          actor: 'alice@example.com',
          ip: '198.51.100.240',
          server: 'lapi-qa',
          duration: '1h',
          type: 'ban',
          reason: 'abuse',
          link: `${DASHBOARD}/alerts/3`,
        },
      ],
    });
    expect(unban).toMatchObject({
      event: 'unban',
      items: [{ actor: 'bob@example.com', decision_id: 42, reason: 'false positive' }],
    });
  });

  it('notifies the start and the end of a CAPI failure streak only', async () => {
    const { service, advance, bodies } = setup([
      target({ events: ['forwarding_error'], min_interval: '0' }),
    ]);
    const at = Date.UTC(2026, 10, 23, 10, 0, 0);
    service.handleStatusEvent({ type: 'capi_forward_succeeded', at, count: 1 });
    service.handleStatusEvent({ type: 'capi_forward_failed', at, count: 1, message: 'HTTP 503' });
    service.handleStatusEvent({ type: 'capi_forward_failed', at, count: 1, message: 'HTTP 503' });
    await advance(1_000);
    service.handleStatusEvent({ type: 'capi_forward_succeeded', at, count: 1 });
    await advance(1_000);
    expect(bodies().map((b) => b.items.map((i: { state: string }) => i.state))).toEqual([
      ['failing'],
      ['recovered'],
    ]);
    expect(bodies()[0].items[0]).toMatchObject({ server: 'CAPI', error: 'HTTP 503' });
  });

  it('turns LAPI health and replication events into lapi_error', async () => {
    const { service, advance, bodies } = setup([
      target({ type: 'slack', events: ['lapi_error'], min_interval: '0' }),
    ]);
    const at = Date.UTC(2026, 10, 23, 10, 0, 0);
    service.handleStatusEvent({
      type: 'lapi_unreachable',
      at,
      server: 'lapi-qa',
      message: 'fetch failed',
    });
    service.handleStatusEvent({
      type: 'replication_failed',
      at,
      server: 'lapi-b',
      message: 'HTTP 500',
    });
    await advance(1_000);
    service.handleStatusEvent({ type: 'lapi_recovered', at, server: 'lapi-qa' });
    await advance(1_000);
    expect(bodies().map((b) => b.text)).toEqual([
      '⚠️ LAPI lapi-qa is unreachable: `fetch failed`\n⚠️ Decision replication to LAPI lapi-b failed: `HTTP 500`',
      '✅ LAPI lapi-qa is reachable again',
    ]);
  });

  it('only sends the events a target subscribed to', async () => {
    const { service, advance, fetchImpl } = setup([target({ events: ['unban'] })]);
    service.notifyAlerts([storedAlert()]);
    service.handleStatusEvent({ type: 'lapi_recovered', at: 0, server: 'x' });
    await advance(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('delivery', () => {
  it('retries a 500 three times (5 s, 30 s, 2 min) then reports the failure', async () => {
    const { service, advance, fetchImpl, logger } = setup(
      [target({ events: ['alert'] })],
      () => new Response('boom', { status: 500 })
    );
    service.notifyAlerts([storedAlert()]);
    await advance(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().targets[0].retrying).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      message: 'HTTP 500',
    });
    await advance(4_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await advance(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await advance(10 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const status = service.getSnapshot().targets[0];
    expect(status.retrying).toBeNull();
    expect(status.queued).toBe(0);
    expect(status.lastResult).toMatchObject({
      ok: false,
      event: 'alert',
      message: 'HTTP 500',
      attempts: 4,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'hook', attempts: 4, error: 'HTTP 500' }),
      'Notification delivery failed'
    );
  });

  it('succeeds on a retry', async () => {
    let calls = 0;
    const { service, advance, fetchImpl } = setup(
      [target({ events: ['alert'] })],
      () => new Response(null, { status: ++calls === 1 ? 503 : 200 })
    );
    service.notifyAlerts([storedAlert()]);
    await advance(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().targets[0].lastResult).toMatchObject({
      ok: true,
      message: 'Delivered',
      attempts: 2,
    });
  });

  it('does not retry a 404 nor follow a redirect', async () => {
    const statuses = [404, 302];
    const { service, advance, fetchImpl } = setup(
      [target({ events: ['alert'], min_interval: '0' })],
      () =>
        new Response(null, {
          status: statuses.shift() ?? 200,
          headers: { Location: 'https://elsewhere.test/' },
        })
    );
    service.notifyAlerts([storedAlert()]);
    await advance(10 * 60_000);
    expect(service.getSnapshot().targets[0].lastResult?.message).toBe('HTTP 404');
    service.notifyAlerts([storedAlert()]);
    await advance(10 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().targets[0].lastResult?.message).toBe(
      'HTTP 302 (redirects are not followed)'
    );
  });

  it('never exposes the URL, its query or the headers in errors and logs', async () => {
    const { service, advance, logger } = setup([target({ events: ['alert'] })], () => {
      throw new Error(`connect ECONNREFUSED ${HOOK_URL} with ${HEADER_SECRET}`);
    });
    service.notifyAlerts([storedAlert()]);
    await advance(10 * 60_000);
    const snapshot = JSON.stringify(service.getSnapshot());
    const logs = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    for (const text of [snapshot, logs]) {
      expect(text).not.toContain('SECRETPATH');
      expect(text).not.toContain('QUERYSECRET');
      expect(text).not.toContain('header-SECRET');
    }
    expect(service.getSnapshot().targets[0]).toMatchObject({
      host: 'hooks.example.test',
      lastResult: { ok: false, attempts: 4 },
    });
  });

  it('caps the outbox and drops the oldest waiting message', async () => {
    const { service, advance, logger, pending } = setup(
      [target({ events: ['alert', 'unban'], min_interval: '0' })],
      () => new Response(null, { status: 500 })
    );
    for (let i = 0; i < MAX_OUTBOX_MESSAGES + 5; i++) {
      service.notifyAlerts([storedAlert()]);
      await advance(1_000);
    }
    const status = service.getSnapshot().targets[0];
    expect(status.queued).toBe(MAX_OUTBOX_MESSAGES);
    expect(status.dropped).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'hook' }),
      'Notification outbox full, dropping the oldest waiting message'
    );
    service.stop();
    expect(pending).toHaveLength(0);
  });

  it('stop() cancels pending timers and sends nothing afterwards', async () => {
    const { service, advance, fetchImpl, pending } = setup([target({ events: ['alert'] })]);
    service.notifyAlerts([storedAlert()]);
    expect(pending.length).toBeGreaterThan(0);
    service.stop();
    expect(pending).toHaveLength(0);
    service.notifyAlerts([storedAlert()]);
    await advance(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('test messages', () => {
  it('delivers a test message right away and records the result', async () => {
    const { service, fetchImpl, bodies } = setup([target({ type: 'slack' })]);
    await expect(service.sendTest('hook')).resolves.toEqual({ ok: true, message: 'Delivered' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toEqual({
      text: `🔔 CrowdSieve test notification from ${DASHBOARD}`,
    });
    expect(service.getSnapshot().targets[0].lastResult).toMatchObject({
      ok: true,
      event: 'test',
      message: 'Delivered',
    });
  });

  it('reports the error of a failed test, without retry', async () => {
    const { service, fetchImpl, bodies } = setup(
      [target()],
      () => new Response(null, { status: 404 })
    );
    await expect(service.sendTest('hook')).resolves.toEqual({ ok: false, message: 'HTTP 404' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({
      event: 'test',
      message: `CrowdSieve test notification from ${DASHBOARD}`,
      items: [],
    });
  });

  it('throttles tests and answers null for an unknown target', async () => {
    const { service, clock } = setup([target()]);
    await service.sendTest('hook');
    await expect(service.sendTest('hook')).resolves.toMatchObject({ ok: false, throttled: true });
    clock.set(clock.now() + TEST_COOLDOWN_MS);
    await expect(service.sendTest('hook')).resolves.toMatchObject({ ok: true });
    await expect(service.sendTest('nope')).resolves.toBeNull();
  });
});

describe('snapshot', () => {
  it('lists the targets without URL path, query or headers', () => {
    const { service } = setup([
      target(),
      target({ name: 'chat', type: 'slack', events: ['unban'] }),
    ]);
    const snapshot = service.getSnapshot();
    expect(snapshot).toMatchObject({
      enabled: true,
      dashboardUrl: DASHBOARD,
      targets: [
        {
          name: 'hook',
          type: 'webhook',
          host: 'hooks.example.test',
          minInterval: '5m',
          minIntervalMs: 300_000,
          match: { status: 'forwarded' },
          lastResult: null,
          queued: 0,
          buffered: 0,
        },
        { name: 'chat', type: 'slack', events: ['unban'], match: null },
      ],
    });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('SECRETPATH');
    expect(text).not.toContain('QUERYSECRET');
    expect(text).not.toContain('header-SECRET');
    expect(text).not.toContain('Authorization');
  });

  it('is disabled without targets', () => {
    const service = createNotificationService({ targets: [] }, silentLogger());
    expect(service.enabled).toBe(false);
    expect(service.getSnapshot()).toEqual({ enabled: false, dashboardUrl: null, targets: [] });
  });
});
