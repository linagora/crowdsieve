import { describe, expect, it } from 'vitest';
import { scenarioFilter } from '../dashboard/lib/scenarioFilter.js';

const scenarios = [
  'crowdsecurity/ssh-bf',
  'crowdsecurity/ssh-slow-bf',
  'crowdsecurity/http-probing',
  'crowdsecurity/http-crawl-non_statics',
  'crowdsecurity/http-bad-user-agent',
  'crowdsecurity/http-cve-2021-41773',
  'crowdsecurity/http-sensitive-files',
];

function filtered(search: string): string[] {
  return scenarios.filter((value) => scenarioFilter(value, search) > 0);
}

describe('scenarioFilter', () => {
  it('keeps only scenarios containing the search term (#73)', () => {
    expect(filtered('ssh')).toEqual(['crowdsecurity/ssh-bf', 'crowdsecurity/ssh-slow-bf']);
  });

  it('is case-insensitive', () => {
    expect(filtered('SSH')).toEqual(['crowdsecurity/ssh-bf', 'crowdsecurity/ssh-slow-bf']);
    expect(filtered('Http-Probing')).toEqual(['crowdsecurity/http-probing']);
  });

  it('does not fuzzy-match letters that are merely in order', () => {
    // cmdk's default scorer kept every http-* item for "ssh" because the
    // letters appear in order; a substring filter must reject them.
    expect(scenarioFilter('crowdsecurity/http-probing', 'ssh')).toBe(0);
    expect(scenarioFilter('crowdsecurity/http-sensitive-files', 'ssh')).toBe(0);
    expect(filtered('zzz')).toEqual([]);
  });

  it('keeps everything for an empty search', () => {
    expect(filtered('')).toHaveLength(scenarios.length);
    expect(filtered('   ')).toHaveLength(scenarios.length);
  });

  it('matches substrings anywhere in the value', () => {
    expect(filtered('probing')).toEqual(['crowdsecurity/http-probing']);
    expect(filtered('security/ssh-bf')).toEqual(['crowdsecurity/ssh-bf']);
  });
});
