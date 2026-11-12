/**
 * cmdk filter for the scenario picker.
 *
 * cmdk's default scorer is a fuzzy match, so a short term such as "ssh" keeps
 * every `crowdsecurity/http-*` scenario (the letters appear in order). Use a
 * plain case-insensitive substring match instead: a non-zero score keeps the
 * item, 0 hides it.
 */
export function scenarioFilter(value: string, search: string): number {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return 1;
  return value.toLowerCase().includes(needle) ? 1 : 0;
}
