/**
 * Dashboard roles: Operator (may ban, unban and run analyzers) and Viewer
 * (read-only).
 *
 * The role is derived from the user's groups and `AUTH_OPERATOR_GROUPS`:
 *   - `AUTH_OPERATOR_GROUPS` empty or unset: every signed-in user is an
 *     Operator (the behaviour before roles existed);
 *   - otherwise a user who belongs to at least one of these groups is an
 *     Operator, anyone else a Viewer.
 *
 * Where the groups come from depends on the auth mode:
 *   - 'oidc'    : the `OIDC_GROUPS_CLAIM` claim (default `groups`) of the ID
 *                 token, or of the userinfo response when the ID token has no
 *                 such claim. The role is computed once, at sign-in, and kept
 *                 in the sealed session cookie (see `roleFromSession`).
 *   - 'headers' : the `AUTH_GROUPS_HEADER` request header (default
 *                 `X-Forwarded-Groups`), read on every request after the
 *                 trusted-upstream checks.
 *   - 'none'    : no user, everyone is an Operator.
 *
 * The role is always computed on the server; nothing sent by the browser is
 * trusted for it.
 *
 * This module must remain Edge-Runtime- and browser-compatible (it is also
 * imported by client code for READ_ONLY_ERROR): no Node.js-only API.
 */

export type UserRole = 'operator' | 'viewer';

/** Error message of the 403 answered to a Viewer by write routes. */
export const READ_ONLY_ERROR = 'Your account is read-only';

/** Label of a role in the user menu; null for an unknown role. */
export function roleLabel(role: UserRole | null | undefined): string | null {
  if (role === 'operator') return 'Operator';
  if (role === 'viewer') return 'Viewer (read-only)';
  return null;
}

/** Default name of the OIDC claim that lists the user's groups. */
export const DEFAULT_GROUPS_CLAIM = 'groups';

/** Default name of the request header that lists the user's groups. */
export const DEFAULT_GROUPS_HEADER = 'X-Forwarded-Groups';

/** Defensive caps on what is read from a claim or header. */
const MAX_GROUPS = 1000;
const MAX_GROUP_LENGTH = 512;

type Env = Record<string, string | undefined>;

function splitList(value: string, separators: RegExp): string[] {
  return value
    .split(separators)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Groups listed in `AUTH_OPERATOR_GROUPS` (comma-separated, trimmed,
 * case-sensitive). Empty when the variable is unset or blank.
 */
export function getOperatorGroups(env: Env = process.env): string[] {
  const raw = env.AUTH_OPERATOR_GROUPS;
  if (!raw) return [];
  return [...new Set(splitList(raw, /,/))];
}

/** Whether roles are enforced, i.e. `AUTH_OPERATOR_GROUPS` lists a group. */
export function isRoleEnforced(env: Env = process.env): boolean {
  return getOperatorGroups(env).length > 0;
}

/** Name of the OIDC claim that lists the groups (`OIDC_GROUPS_CLAIM`). */
export function getGroupsClaim(env: Env = process.env): string {
  const claim = env.OIDC_GROUPS_CLAIM?.trim();
  return claim && claim.length > 0 ? claim : DEFAULT_GROUPS_CLAIM;
}

/** Name of the request header that lists the groups (`AUTH_GROUPS_HEADER`), lowercase. */
export function getGroupsHeader(env: Env = process.env): string {
  const header = env.AUTH_GROUPS_HEADER?.trim();
  return (header && header.length > 0 ? header : DEFAULT_GROUPS_HEADER).toLowerCase();
}

/**
 * Normalize a list of groups from a claim or a header:
 *   - a string is split on commas, semicolons (LemonLDAP::NG joins
 *     `$groups` with "; ") and pipes (authentik's `X-authentik-groups`);
 *   - an array keeps each string element as one group (no splitting, so
 *     names such as LDAP DNs survive);
 *   - anything else gives no group.
 * Entries are trimmed, empty ones dropped, and CR/LF removed.
 */
export function parseGroupList(value: unknown): string[] {
  let entries: string[];
  if (typeof value === 'string') {
    entries = splitList(value.replace(/[\r\n]/g, ''), /[,;|]/);
  } else if (Array.isArray(value)) {
    entries = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.replace(/[\r\n]/g, '').trim())
      .filter((entry) => entry.length > 0);
  } else {
    return [];
  }
  return entries.filter((entry) => entry.length <= MAX_GROUP_LENGTH).slice(0, MAX_GROUPS);
}

/**
 * Read a claim by name. An exact key wins (so namespaced claims such as
 * `https://example.com/groups` work); otherwise a dotted name is followed
 * through nested objects (`realm_access.roles`).
 */
export function readClaim(
  claims: Record<string, unknown> | null | undefined,
  name: string
): unknown {
  if (!claims || typeof claims !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(claims, name)) return claims[name];
  if (!name.includes('.')) return undefined;
  let current: unknown = claims;
  for (const part of name.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The user's groups that are listed in `AUTH_OPERATOR_GROUPS`. */
export function matchOperatorGroups(groups: string[], env: Env = process.env): string[] {
  const operatorGroups = new Set(getOperatorGroups(env));
  return [...new Set(groups.filter((group) => operatorGroups.has(group)))];
}

/** Role of a user with these groups under the current configuration. */
export function roleForGroups(groups: string[], env: Env = process.env): UserRole {
  if (!isRoleEnforced(env)) return 'operator';
  return matchOperatorGroups(groups, env).length > 0 ? 'operator' : 'viewer';
}

/**
 * Role of a headers-mode request, from the `AUTH_GROUPS_HEADER` header.
 * The caller MUST have checked the trusted upstream first.
 */
export function roleFromHeaders(headers: Headers, env: Env = process.env): UserRole {
  if (!isRoleEnforced(env)) return 'operator';
  return roleForGroups(parseGroupList(headers.get(getGroupsHeader(env))), env);
}

/** What the OIDC callback stores in the session about the role. */
export interface SessionRoleData {
  role?: unknown;
  /** The user's groups that granted the Operator role at sign-in. */
  operatorGroups?: unknown;
}

/**
 * Role stored at sign-in, as seen under the current configuration:
 *   - roles not enforced: Operator;
 *   - session sealed before roles existed (no role): Viewer until the next
 *     sign-in, since the groups are unknown;
 *   - Operator only while one of the groups that granted it is still listed
 *     in `AUTH_OPERATOR_GROUPS` (removing a group from the setting demotes
 *     its members at once; adding one takes effect at their next sign-in).
 */
export function roleFromSession(
  data: SessionRoleData | null | undefined,
  env: Env = process.env
): UserRole {
  if (!isRoleEnforced(env)) return 'operator';
  if (!data || data.role !== 'operator') return 'viewer';
  return matchOperatorGroups(parseGroupList(data.operatorGroups), env).length > 0
    ? 'operator'
    : 'viewer';
}

/**
 * Compute the role at OIDC sign-in. Groups come from the ID token claims;
 * when the claim is absent there, from the userinfo response
 * (`loadUserInfo`). A failing userinfo request is logged and gives no group
 * (Viewer). Userinfo is not requested when roles are not enforced.
 */
export async function resolveSignInRole(
  idTokenClaims: Record<string, unknown>,
  loadUserInfo: () => Promise<Record<string, unknown>>,
  env: Env = process.env
): Promise<{ role: UserRole; operatorGroups: string[] }> {
  if (!isRoleEnforced(env)) return { role: 'operator', operatorGroups: [] };

  const claim = getGroupsClaim(env);
  let value = readClaim(idTokenClaims, claim);
  if (value === undefined) {
    try {
      value = readClaim(await loadUserInfo(), claim);
    } catch (error) {
      console.error(
        `[auth] Could not read the "${claim}" claim from the userinfo endpoint; ` +
          'signing the user in as read-only:',
        error
      );
      value = undefined;
    }
  }

  const operatorGroups = matchOperatorGroups(parseGroupList(value), env);
  return { role: operatorGroups.length > 0 ? 'operator' : 'viewer', operatorGroups };
}
