import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM config without type declarations
import nextConfig from '../dashboard/next.config.mjs';

const apiDir = join(__dirname, '..', 'dashboard', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === 'route.ts' ? [full] : [];
  });
}

/** `/api/alerts/[id]/raw` for `app/api/alerts/[id]/raw/route.ts`. */
function routePath(file: string): string {
  const dir = relative(join(apiDir, '..'), file).split(sep).slice(0, -1);
  return '/' + dir.join('/');
}

describe('dashboard next.config rewrites', () => {
  it('never shadow a route handler under app/api', async () => {
    const rewrites = (await nextConfig.rewrites?.()) ?? [];
    const list: { source: string }[] = Array.isArray(rewrites)
      ? rewrites
      : [
          ...(rewrites.beforeFiles ?? []),
          ...(rewrites.afterFiles ?? []),
          ...(rewrites.fallback ?? []),
        ].filter(Boolean);
    // Plain arrays and beforeFiles/afterFiles run before dynamic routes.
    const shadowing = Array.isArray(rewrites)
      ? list
      : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? [])];

    const routes = routeFiles(apiDir).map(routePath);
    expect(routes.length).toBeGreaterThan(0);
    for (const { source } of shadowing) {
      const prefix = source.replace(/\/:[^/]*\*?$/, '').replace(/\/$/, '');
      for (const route of routes) {
        expect(route === prefix || route.startsWith(prefix + '/')).toBe(false);
      }
    }
  });
});
