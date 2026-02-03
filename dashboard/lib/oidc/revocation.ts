/**
 * SECURITY: In-memory session revocation store for back-channel logout
 *
 * This module tracks revoked sessions to support OIDC back-channel logout.
 * When the OIDC provider sends a logout token, we mark the session as revoked
 * so subsequent requests with that session are rejected.
 *
 * LIMITATIONS (production considerations):
 * - In-memory only: revocations are lost on server restart
 * - Single instance: not shared across multiple servers
 * - For production, consider Redis or database-backed storage
 *
 * SECURITY NOTES:
 * - Revocations are checked on every authenticated request (via isSessionValid)
 * - TTL prevents unbounded memory growth from revocation records
 */

interface RevokedSession {
  sid: string;
  sub: string;
  revokedAt: number;
}

// Map of sid -> revocation info
const revokedSessions = new Map<string, RevokedSession>();

// Track individual revoked sessions by user (sub -> Set of sids)
const revokedByUser = new Map<string, Set<string>>();

// Separate tracking for users with ALL sessions revoked (avoids '*' marker ambiguity)
const allSessionsRevokedForUser = new Set<string>();

// How long to keep revocation records (24 hours)
const REVOCATION_TTL_MS = 24 * 60 * 60 * 1000;

export function revokeSession(sid: string, sub: string): void {
  revokedSessions.set(sid, {
    sid,
    sub,
    revokedAt: Date.now(),
  });

  // Track by user
  if (!revokedByUser.has(sub)) {
    revokedByUser.set(sub, new Set());
  }
  revokedByUser.get(sub)!.add(sid);
}

export function revokeAllUserSessions(sub: string): void {
  // Mark all sessions for this user as revoked (present and future until TTL)
  allSessionsRevokedForUser.add(sub);
}

export function isSessionRevoked(sid: string | undefined, sub: string): boolean {
  if (!sid) {
    return false;
  }

  // Check if all sessions for this user are revoked
  if (allSessionsRevokedForUser.has(sub)) {
    return true;
  }

  // Check if this specific session is revoked
  if (revokedSessions.has(sid)) {
    return true;
  }

  return false;
}

// Cleanup old revocation records
export function cleanupRevocations(): void {
  const now = Date.now();
  const cutoff = now - REVOCATION_TTL_MS;

  for (const [sid, info] of revokedSessions) {
    if (info.revokedAt < cutoff) {
      revokedSessions.delete(sid);
      const userSids = revokedByUser.get(info.sub);
      if (userSids) {
        userSids.delete(sid);
        // Clean up empty Sets to prevent memory leak
        if (userSids.size === 0) {
          revokedByUser.delete(info.sub);
        }
      }
    }
  }
}

// Run cleanup periodically (every hour)
// Only in Node.js runtime, not Edge runtime
if (typeof setInterval === 'function') {
  try {
    setInterval(cleanupRevocations, 60 * 60 * 1000);
  } catch {
    // Edge runtime doesn't support long-running timers
  }
}
