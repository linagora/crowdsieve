/**
 * Notifications end to end: the proxy server (fastify inject) with the real
 * SQLite storage and filter engine, the configuration loaded from YAML, and
 * a local HTTP server as webhook target. Covers the acceptance criteria of
 * the notifications feature: alert matching and filtered alerts, digests,
 * manual ban and unban events, Slack text, retries and the status route,
 * "Send test", and /v2/signals not waiting for the targets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { initializeDatabase, closeDatabase } from '../src/db/index.js';
import { createStorage } from '../src/storage/index.js';
import { createLogger } from '../src/logging.js';
import { loadConfig, type Config } from '../src/config/index.js';
import { FilterEngine } from '../src/filters/index.js';
import { createProxyServer } from '../src/proxy/server.js';
import { clearTokenCache } from '../src/auth/machineToken.js';
import { createNotificationService, type NotificationService } from '../src/notifications/index.js';

const API_KEY = 'notifications-test-api-key';
const DASHBOARD = 'https://crowdsieve.example.com';
const HOOK_TOKEN = 'hook-SECRET-token';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsieve-notifications-'));
const DB_PATH = path.join(TMP, 'crowdsieve.db');
const LAPI_URL = 'http://lapi-qa.test:8080';

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  at: number;
}

const received: Received[] = [];
/** Per path: HTTP status and delay of the answer. */
const behaviour = new Map<string, { status: number; delayMs: number }>();

const hookServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const urlPath = (req.url ?? '').split('?')[0];
    received.push({
      path: urlPath,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      at: Date.now(),
    });
    const { status, delayMs } = behaviour.get(urlPath) ?? { status: 200, delayMs: 0 };
    setTimeout(() => {
      res.statusCode = status;
      res.end('ok');
    }, delayMs);
  });
});

let app: FastifyInstance;
let notifications: NotificationService;
let realFetch: typeof fetch;
let hookBase: string;

const at = (p: string) => received.filter((r) => r.path === p);

async function waitForRequests(p: string, count: number, timeout = 3000): Promise<Received[]> {
  await vi.waitFor(
    () => {
      expect(at(p).length).toBeGreaterThanOrEqual(count);
    },
    { timeout, interval: 10 }
  );
  return at(p);
}

async function quiet(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function signal(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const ip = (overrides.ip as string | undefined) ?? '203.0.113.7';
  delete overrides.ip;
  return {
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    machine_id: 'qa-agent',
    scenario: 'crowdsecurity/ssh-bf',
    scenario_hash: 'h',
    scenario_version: '1',
    message: 'm',
    events_count: 1,
    start_at: now,
    stop_at: now,
    capacity: 5,
    leakspeed: '10s',
    simulated: false,
    events: [],
    source: { scope: 'ip', value: ip, ip, cn: 'FR' },
    decisions: [],
    ...overrides,
  };
}

async function postSignals(alerts: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/v2/signals',
    headers: { 'content-type': 'application/json' },
    payload: alerts,
  });
}

function writeConfig(base: string): Config {
  const file = path.join(TMP, 'filters.yaml');
  fs.writeFileSync(
    file,
    `
proxy:
  forward_enabled: false
storage:
  type: sqlite
  path: "${DB_PATH}"
lapi_servers:
  - name: lapi-qa
    url: "${LAPI_URL}"
    api_key: bouncer-key
    machine_id: crowdsieve
    password: machine-password
notifications:
  dashboard_url: "${DASHBOARD}/"
  targets:
    - name: alerts-hook
      type: webhook
      url: "${base}/alerts-hook?token=query-secret"
      headers:
        Authorization: "Bearer \${NOTIF_TEST_HOOK_TOKEN}"
      events: [alert]
      match:
        scenarios: [ssh-bf]
      min_interval: "0"
    - name: digest-hook
      type: webhook
      url: "${base}/digest-hook"
      events: [alert]
      match:
        scenarios: [http-probing]
        status: any
      min_interval: 400ms
    - name: bans-hook
      type: webhook
      url: "${base}/bans-hook"
      events: [manual_ban, unban]
      min_interval: "0"
    - name: chat
      type: slack
      url: "${base}/chat"
      events: [alert, manual_ban]
      match:
        scenarios: [ssh-bf]
      min_interval: "0"
    - name: broken
      type: webhook
      url: "${base}/broken"
      events: [lapi_error]
      min_interval: "0"
    - name: slow
      type: webhook
      url: "${base}/slow"
      events: [alert]
      match:
        scenarios: [slow-scenario]
      min_interval: "0"
`
  );
  process.env.NOTIF_TEST_HOOK_TOKEN = HOOK_TOKEN;
  return loadConfig(file);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hookBase = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;
  behaviour.set('/broken', { status: 500, delayMs: 0 });
  behaviour.set('/slow', { status: 200, delayMs: 1500 });

  const config = writeConfig(hookBase);
  await initializeDatabase(config, pino({ level: 'silent' }));
  const logger = createLogger({ level: 'silent' });

  // The LAPI is mocked through the global fetch; the notification service
  // talks to the local HTTP server with the real fetch.
  realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(LAPI_URL)) return realFetch(input, init);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/v1/watchers/login')) {
        return json({ token: 'jwt', expire: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (url.endsWith('/v1/alerts')) return json(['42']);
      if (url.includes('/v1/decisions?')) {
        return json([{ id: 42, scope: 'Ip', value: '198.51.100.240' }]);
      }
      if (url.endsWith('/v1/decisions/42')) return json({ nbDeleted: '1' });
      return new Response('not found', { status: 404 });
    })
  );

  notifications = createNotificationService(config.notifications, logger, {
    fetchImpl: realFetch,
    groupWaitMs: 20,
    retryDelaysMs: [20, 20, 20],
    requestTimeoutMs: 5000,
  });

  process.env.DASHBOARD_API_KEY = API_KEY;
  app = await createProxyServer({
    config,
    filterEngine: new FilterEngine('block', [
      {
        name: 'internal-ips',
        enabled: true,
        filter: { field: 'source.ip', op: 'cidr', value: ['10.0.0.0/8'] },
      },
    ]),
    storage: createStorage(),
    logger,
    notificationService: notifications,
  });
  await app.ready();
});

afterAll(async () => {
  notifications?.stop();
  await app?.close();
  vi.unstubAllGlobals();
  clearTokenCache();
  await closeDatabase();
  await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  hookServer.closeAllConnections?.();
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.NOTIF_TEST_HOOK_TOKEN;
});

beforeEach(() => {
  received.length = 0;
});

describe('alert notifications', () => {
  it('sends one JSON POST with the id, scenario, IP and link of a matching alert', async () => {
    const res = await postSignals([signal()]);
    expect(res.statusCode).toBe(200);

    const [request] = await waitForRequests('/alerts-hook', 1);
    await quiet();
    expect(at('/alerts-hook')).toHaveLength(1);
    expect(request.headers.authorization).toBe(`Bearer ${HOOK_TOKEN}`);
    expect(request.headers['content-type']).toBe('application/json');
    const body = request.body as { items: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ event: 'alert', crowdsieve_url: DASHBOARD, total: 1 });
    const id = body.items[0].id as number;
    expect(body.items[0]).toEqual({
      occurred_at: expect.any(String),
      id: expect.any(Number),
      scenario: 'crowdsecurity/ssh-bf',
      ip: '203.0.113.7',
      country: 'FR',
      machine: 'qa-agent',
      filtered: false,
      link: `${DASHBOARD}/alerts/${id}`,
    });

    // The id is the stored alert's.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/alerts/${id}`,
      headers: { 'X-API-Key': API_KEY },
    });
    expect(detail.json()).toMatchObject({
      scenario: 'crowdsecurity/ssh-bf',
      sourceIp: '203.0.113.7',
    });
  });

  it('sends nothing for a filtered ssh-bf alert (status forwarded)', async () => {
    await postSignals([signal({ ip: '10.1.2.3' })]);
    await quiet(300);
    expect(at('/alerts-hook')).toHaveLength(0);
    expect(at('/chat')).toHaveLength(0);
  });

  it('sends a Slack-compatible { text } message', async () => {
    await postSignals([signal({ ip: '198.51.100.7' })]);
    const [request] = await waitForRequests('/chat', 1);
    expect(Object.keys(request.body)).toEqual(['text']);
    expect(request.body.text).toMatch(
      new RegExp(
        `^🚨 \`crowdsecurity/ssh-bf\` from 198\\.51\\.100\\.7 \\(FR\\) on \`qa-agent\` — ${DASHBOARD.replace(/\./g, '\\.')}/alerts/\\d+$`
      )
    );
  });

  it('groups ten matching alerts within min_interval instead of sending ten messages', async () => {
    for (let i = 0; i < 10; i++) {
      await postSignals([
        signal({ scenario: 'crowdsecurity/http-probing', ip: `203.0.113.${i + 10}` }),
      ]);
    }
    await waitForRequests('/digest-hook', 1);
    await quiet(800);
    const messages = at('/digest-hook');
    expect(messages.length).toBeLessThanOrEqual(2);
    const total = messages.reduce((sum, m) => sum + (m.body.total as number), 0);
    expect(total).toBe(10);
    expect(messages[0].body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ ip: '203.0.113.10' })])
    );
  });

  it('answers /v2/signals without waiting for the targets', async () => {
    const started = Date.now();
    const res = await postSignals([signal({ scenario: 'acme/slow-scenario' })]);
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // The target answers after 1.5 s; the signals answer does not wait.
    expect(elapsed).toBeLessThan(1000);
    const [request] = await waitForRequests('/slow', 1);
    expect(request.at).toBeGreaterThanOrEqual(started);
  });
});

describe('manual ban and unban notifications', () => {
  it('sends manual_ban with the actor, IP, server, duration and reason, then unban', async () => {
    const ban = await app.inject({
      method: 'POST',
      url: '/api/decisions/ban',
      headers: { 'X-API-Key': API_KEY, 'X-CrowdSieve-Actor': 'alice@example.com' },
      payload: { server: 'lapi-qa', ip: '198.51.100.240', duration: '1h', reason: 'abuse report' },
    });
    expect(ban.statusCode).toBe(200);
    const [banMessage] = await waitForRequests('/bans-hook', 1);
    expect(banMessage.body).toMatchObject({
      event: 'manual_ban',
      items: [
        {
          actor: 'alice@example.com',
          ip: '198.51.100.240',
          server: 'lapi-qa',
          duration: '1h',
          type: 'ban',
          reason: 'abuse report',
          link: expect.stringMatching(new RegExp(`^${DASHBOARD}/alerts/\\d+$`)),
        },
      ],
    });
    const [chat] = await waitForRequests('/chat', 1);
    expect(chat.body.text).toMatch(
      /^🔒 `alice@example\.com` banned 198\.51\.100\.240 on lapi-qa for 1h: `abuse report`/
    );

    const unban = await app.inject({
      method: 'DELETE',
      url: '/api/decisions/42?server=lapi-qa',
      headers: { 'X-API-Key': API_KEY, 'X-CrowdSieve-Actor': 'bob@example.com' },
      payload: { reason: 'false positive', ip: '198.51.100.240' },
    });
    expect(unban.statusCode).toBe(200);
    const messages = await waitForRequests('/bans-hook', 2);
    expect(messages[1].body).toMatchObject({
      event: 'unban',
      items: [
        {
          actor: 'bob@example.com',
          ip: '198.51.100.240',
          server: 'lapi-qa',
          decision_id: 42,
          reason: 'false positive',
        },
      ],
    });
  });
});

describe('GET /api/notifications and POST /api/notifications/:name/test', () => {
  const get = () =>
    app.inject({ method: 'GET', url: '/api/notifications', headers: { 'X-API-Key': API_KEY } });
  const test = (name: string) =>
    app.inject({
      method: 'POST',
      url: `/api/notifications/${name}/test`,
      headers: { 'X-API-Key': API_KEY },
    });

  it('requires the API key', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/notifications/chat/test' })).statusCode
    ).toBe(401);
  });

  it('retries a target answering 500 three times, then shows "HTTP 500"', async () => {
    notifications.handleStatusEvent({
      type: 'lapi_unreachable',
      at: Date.now(),
      server: 'lapi-qa',
      message: 'fetch failed',
    });
    await waitForRequests('/broken', 4);
    await vi.waitFor(async () => {
      const broken = (await get())
        .json()
        .targets.find((t: { name: string }) => t.name === 'broken');
      expect(broken.lastResult).toMatchObject({
        ok: false,
        event: 'lapi_error',
        message: 'HTTP 500',
        attempts: 4,
      });
    });
    await quiet();
    expect(at('/broken')).toHaveLength(4);
  });

  it('lists the targets without URL path, query string or header values', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.dashboardUrl).toBe(DASHBOARD);
    expect(body.targets.map((t: { name: string }) => t.name)).toEqual([
      'alerts-hook',
      'digest-hook',
      'bans-hook',
      'chat',
      'broken',
      'slow',
    ]);
    expect(body.targets[0]).toMatchObject({
      type: 'webhook',
      host: new URL(hookBase).host,
      events: ['alert'],
      minInterval: '0',
      minIntervalMs: 0,
      match: { scenarios: ['ssh-bf'], status: 'forwarded' },
    });
    const text = res.body;
    expect(text).not.toContain('alerts-hook?');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain(HOOK_TOKEN);
    expect(text).not.toContain('/alerts-hook');
  });

  it('sends a test message and reports "Delivered"', async () => {
    const res = await test('chat');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, message: 'Delivered' });
    const [request] = await waitForRequests('/chat', 1);
    expect(request.body).toEqual({ text: `🔔 CrowdSieve test notification from ${DASHBOARD}` });
    const chat = (await get()).json().targets.find((t: { name: string }) => t.name === 'chat');
    expect(chat.lastResult).toMatchObject({ ok: true, event: 'test', message: 'Delivered' });
  });

  it('reports the error of a failed test, throttles repeated tests and 404s unknown targets', async () => {
    const res = await test('broken');
    expect(res.json()).toEqual({ ok: false, message: 'HTTP 500' });
    expect((await test('broken')).statusCode).toBe(429);
    expect((await test('missing')).statusCode).toBe(404);
    expect((await test('bad%20name')).statusCode).toBe(400);
  });
});
