import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isPublicIp, ctiUrl } from '../dashboard/lib/publicIp.js';
import { getRuntimeConfig, parseCtiLinksEnabled } from '../dashboard/lib/runtimeConfig.js';
import { CtiLink } from '../dashboard/components/CtiLink.js';
import { RuntimeConfigProvider } from '../dashboard/components/RuntimeConfigProvider.js';

describe('isPublicIp', () => {
  it.each([
    '203.0.113.7', // documentation ranges keep the link
    '198.51.100.23',
    '192.0.2.1',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2001:db8::1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::FFFF:0808:0808',
    ' 8.8.8.8 ',
  ])('accepts %s', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each([
    // ranges
    '192.0.2.0/28',
    '2001:db8::/32',
    '8.8.8.0/24',
    // private, loopback, link-local, unspecified, CGNAT, multicast, reserved
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.10.1',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    // IPv4-mapped / NAT64 / compatible forms of non-public addresses
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::10.0.0.1',
    '::10.0.0.1',
  ])('rejects %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    '',
    'not-an-ip',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.4 ; rm',
    '<script>',
    '1::2::3',
    'fe80::1%eth0',
    '12345::1',
    'AS1234',
    'FR',
  ])('rejects malformed value %j', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isPublicIp(null)).toBe(false);
    expect(isPublicIp(undefined)).toBe(false);
  });
});

describe('ctiUrl', () => {
  it('builds the CrowdSec CTI page of an IP', () => {
    expect(ctiUrl('203.0.113.7')).toBe('https://app.crowdsec.net/cti/203.0.113.7');
    expect(ctiUrl('2001:db8::1')).toBe('https://app.crowdsec.net/cti/2001%3Adb8%3A%3A1');
  });
});

describe('CTI_LINKS_ENABLED', () => {
  it('is enabled by default and unless explicitly disabled', () => {
    expect(parseCtiLinksEnabled(undefined)).toBe(true);
    expect(parseCtiLinksEnabled('')).toBe(true);
    expect(parseCtiLinksEnabled('true')).toBe(true);
    for (const v of ['false', 'FALSE', ' False ', '0', 'no', 'off']) {
      expect(parseCtiLinksEnabled(v)).toBe(false);
    }
  });

  it('is read from the environment passed in', () => {
    expect(getRuntimeConfig({ CTI_LINKS_ENABLED: 'false' } as NodeJS.ProcessEnv)).toEqual({
      ctiLinksEnabled: false,
    });
    expect(getRuntimeConfig({} as NodeJS.ProcessEnv)).toEqual({ ctiLinksEnabled: true });
  });
});

describe('CtiLink', () => {
  const render = (ip: string | null, enabled?: boolean) => {
    const link = createElement(CtiLink, { ip });
    return renderToStaticMarkup(
      enabled === undefined
        ? link
        : createElement(RuntimeConfigProvider, { config: { ctiLinksEnabled: enabled } }, link)
    );
  };

  it('links a public IP to CrowdSec CTI in a new tab', () => {
    const html = render('203.0.113.7');
    expect(html).toContain('href="https://app.crowdsec.net/cti/203.0.113.7"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open this IP&#x27;s reputation on CrowdSec CTI (external site)");
    expect(html).toContain('CrowdSec CTI ↗');
  });

  it('renders nothing for private addresses and ranges', () => {
    expect(render('10.1.2.3')).toBe('');
    expect(render('192.0.2.0/28')).toBe('');
    expect(render(null)).toBe('');
  });

  it('renders nothing when CTI links are disabled', () => {
    expect(render('203.0.113.7', false)).toBe('');
    expect(render('203.0.113.7', true)).toContain('CrowdSec CTI');
  });
});
