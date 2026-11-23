/**
 * Best-effort decode of the machine id (`id` claim) of a CrowdSec machine JWT,
 * as carried by the `Authorization` header of LAPI -> CAPI traffic.
 *
 * The signature is NOT verified here: CrowdSieve does not hold CAPI's key.
 * The claim can only be trusted once CAPI has accepted this exact header,
 * i.e. after a `ClientValidator.validate` result with `authenticated: true`
 * (the validation cache is keyed on a hash of the full header, so a cached
 * result covers the same claims). Without that, treat the value as a label.
 *
 * Returns `undefined` when the header is missing or malformed.
 */
export function extractJwtMachineId(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = m ? m[1] : authHeader.trim();
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    // JWT payload is base64url
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    // CrowdSec emits `id` for machine tokens.
    const id = obj.id ?? obj.machine_id ?? obj.sub;
    if (typeof id === 'string' && id.length > 0) return id;
    return undefined;
  } catch {
    return undefined;
  }
}
