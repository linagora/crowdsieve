/**
 * Runtime settings of the dashboard that client components need.
 *
 * Read on the server at request time (never through NEXT_PUBLIC_ variables,
 * which are frozen at build time) and handed to the client by the root
 * layout through `RuntimeConfigProvider`.
 */

export interface RuntimeConfig {
  /** Show "CrowdSec CTI" links next to public IP addresses. */
  ctiLinksEnabled: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = { ctiLinksEnabled: true };

const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/** `CTI_LINKS_ENABLED`: enabled unless explicitly set to false/0/no/off. */
export function parseCtiLinksEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !FALSE_VALUES.has(value.trim().toLowerCase());
}

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return { ctiLinksEnabled: parseCtiLinksEnabled(env.CTI_LINKS_ENABLED) };
}
