/**
 * Startup checks of the dashboard authentication configuration
 * (dashboard/lib/auth/startup.ts, run from instrumentation.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalEnv = { ...process.env };

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

async function runChecks(): Promise<void> {
  const { checkAuthConfiguration } = await import('../dashboard/lib/auth/startup.js');
  checkAuthConfiguration();
}

function warnings(): string {
  return warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  for (const name of [
    'AUTH_MODE',
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'SESSION_SECRET',
    'AUTH_PROXY_SECRET',
    'TRUSTED_PROXY_IPS',
  ]) {
    delete process.env[name];
  }
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('checkAuthConfiguration: OIDC mode', () => {
  it('logs an error in production when SESSION_SECRET is missing', async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.NODE_ENV = 'production';
    await runChecks();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/SESSION_SECRET/);
  });

  it('stays silent with a valid SESSION_SECRET', async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a'.repeat(64);
    await runChecks();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('checkAuthConfiguration: headers mode (GHSA-rjx9-mrqq-772w)', () => {
  it('warns when AUTH_PROXY_SECRET is not set', async () => {
    process.env.AUTH_MODE = 'headers';
    await runChecks();

    expect(warnings()).toMatch(/without AUTH_PROXY_SECRET/);
  });

  it('warns that TRUSTED_PROXY_IPS alone is not a protection', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    await runChecks();

    expect(warnings()).toMatch(/TRUSTED_PROXY_IPS does not prevent this/);
  });

  it('warns about a short AUTH_PROXY_SECRET', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_PROXY_SECRET = 'short';
    await runChecks();

    expect(warnings()).toMatch(/AUTH_PROXY_SECRET is shorter than 32/);
  });

  it('stays silent with a strong AUTH_PROXY_SECRET', async () => {
    process.env.AUTH_MODE = 'headers';
    process.env.AUTH_PROXY_SECRET = 'b'.repeat(64);
    await runChecks();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('checkAuthConfiguration: no authentication (GHSA-x9j8-8c9m-cmpp)', () => {
  it('warns loudly when the mode resolves to none implicitly', async () => {
    await runChecks();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toMatch(/WITHOUT AUTHENTICATION/);
    expect(warnings()).toMatch(/AUTH_MODE=none/);
  });

  it('only logs a notice when AUTH_MODE=none is explicit', async () => {
    process.env.AUTH_MODE = 'none';
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await runChecks();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toMatch(/authentication is disabled/);
  });

  it('flags an unknown AUTH_MODE that falls back to none', async () => {
    process.env.AUTH_MODE = 'odic';
    await runChecks();

    expect(warnings()).toMatch(/Unknown AUTH_MODE "odic"/);
    expect(warnings()).toMatch(/WITHOUT AUTHENTICATION/);
  });

  it('does not warn when OIDC is auto-detected', async () => {
    process.env.OIDC_ISSUER = 'https://sso.example.com';
    process.env.OIDC_CLIENT_ID = 'crowdsieve';
    process.env.SESSION_SECRET = 'c'.repeat(64);
    await runChecks();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
