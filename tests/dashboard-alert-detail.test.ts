import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isDecisionExpired,
  manualBanDecisionFromRaw,
  prettyPrintJson,
} from '../dashboard/lib/alertDetail.js';
import { AlertDecisionsCard } from '../dashboard/components/AlertDecisionsCard.js';
import { AlertEventsCard } from '../dashboard/components/AlertEventsCard.js';

describe('manualBanDecisionFromRaw', () => {
  const raw = (o: Record<string, unknown>) => JSON.stringify(o);

  it('rebuilds the decision of a manual-ban audit row', () => {
    expect(
      manualBanDecisionFromRaw(
        raw({
          kind: 'manual-ban',
          server: 'lapi-1',
          duration: '4h',
          ip: '198.51.100.23',
          scope: 'ip',
          decisionId: 12,
        })
      )
    ).toMatchObject({
      type: 'ban',
      scope: 'Ip',
      value: '198.51.100.23',
      duration: '4h',
      server: 'lapi-1',
      id: 12,
    });
    expect(
      manualBanDecisionFromRaw(raw({ kind: 'manual-ban', ip: '192.0.2.0/28', scope: 'range' }))
    ).toMatchObject({ scope: 'Range', duration: null, server: null });
  });

  it('ignores other kinds and unusable payloads', () => {
    expect(manualBanDecisionFromRaw(raw({ kind: 'unban', ip: '1.2.3.4' }))).toBeNull();
    expect(manualBanDecisionFromRaw(raw({ kind: 'manual-ban' }))).toBeNull();
    expect(manualBanDecisionFromRaw('nope')).toBeNull();
    expect(manualBanDecisionFromRaw(null)).toBeNull();
  });
});

describe('isDecisionExpired / prettyPrintJson', () => {
  it('compares the expiry with now', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(isDecisionExpired('2026-01-01T11:00:00Z', now)).toBe(true);
    expect(isDecisionExpired('2026-01-01T13:00:00Z', now)).toBe(false);
    expect(isDecisionExpired(null, now)).toBe(false);
    expect(isDecisionExpired('garbage', now)).toBe(false);
  });

  it('pretty-prints JSON and leaves other text alone', () => {
    expect(prettyPrintJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPrintJson('not json')).toBe('not json');
  });
});

describe('AlertDecisionsCard', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const decision = {
    id: 1,
    type: 'ban',
    scope: 'Ip',
    value: '203.0.113.7',
    duration: '4h',
    origin: 'crowdsec',
    scenario: null,
    until: '2026-01-01T16:00:00Z',
    simulated: false,
  };

  it('lists the decision with type, value, duration and expiry', () => {
    const html = renderToStaticMarkup(
      createElement(AlertDecisionsCard, { decisions: [decision], now })
    );
    expect(html).toContain('>ban<');
    expect(html).toContain('Ip: 203.0.113.7');
    expect(html).toContain('4h');
    expect(html).toContain('2026-01-01 16:00:00 UTC');
    expect(html).toContain('href="/decisions?ip=203.0.113.7"');
    expect(html).not.toContain('expired');
  });

  it('flags expired decisions and escapes hostile values', () => {
    const html = renderToStaticMarkup(
      createElement(AlertDecisionsCard, {
        decisions: [
          { ...decision, until: '2026-01-01T08:00:00Z', origin: '<img src=x onerror=alert(1)>' },
        ],
        now,
      })
    );
    expect(html).toContain('expired');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('says so when no decision was taken', () => {
    const html = renderToStaticMarkup(createElement(AlertDecisionsCard, { decisions: [], now }));
    expect(html).toContain('No decision was taken for this alert');
  });
});

describe('AlertEventsCard', () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    meta: [
      { key: 'service', value: 'ssh' },
      { key: 'user', value: `<script>alert(${i})</script>` },
    ],
  }));

  it('shows the first 10 events with their meta chips, escaped', () => {
    const html = renderToStaticMarkup(createElement(AlertEventsCard, { events, total: 12 }));
    expect(html).toContain('Events (12)');
    expect(html).toContain('service: ssh');
    expect(html.match(/service: ssh/g)).toHaveLength(10);
    expect(html).toContain('Show all 12 events');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('Showing 12 of');
  });

  it('reports a truncated list', () => {
    const html = renderToStaticMarkup(createElement(AlertEventsCard, { events, total: 80 }));
    expect(html).toContain('Showing 12 of 80 events');
  });

  it('says so when there is no event', () => {
    const html = renderToStaticMarkup(createElement(AlertEventsCard, { events: [], total: 0 }));
    expect(html).toContain('Events (0)');
    expect(html).toContain('No events stored for this alert');
  });
});
