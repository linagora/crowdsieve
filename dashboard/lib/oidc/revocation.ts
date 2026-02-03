// In-memory session revocation store
// In production, this should be backed by Redis or a database for persistence across restarts
// and for multi-instance deployments

interface RevokedSession {
  sid: string;
  sub: string;
  revokedAt: number;
}

// Map of sid -> revocation info
const revokedSessions = new Map<string, RevokedSession>();

// Also track by sub for "logout all sessions for user" scenarios
const revokedByUser = new Map<string, Set<string>>();

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
  // Mark all known sessions for this user as revoked
  // Note: This only affects sessions we know about through previous revocations
  // For new sessions, we'd need a database to track active sessions
  if (!revokedByUser.has(sub)) {
    revokedByUser.set(sub, new Set());
  }
  // We store a special marker to indicate all sessions should be revoked
  revokedByUser.get(sub)!.add('*');
}

export function isSessionRevoked(sid: string | undefined, sub: string): boolean {
  if (!sid) {
    return false;
  }

  // Check if this specific session is revoked
  if (revokedSessions.has(sid)) {
    return true;
  }

  // Check if all sessions for this user are revoked
  const userRevocations = revokedByUser.get(sub);
  if (userRevocations?.has('*')) {
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
      revokedByUser.get(info.sub)?.delete(sid);
    }
  }
}

// Run cleanup periodically (every hour)
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRevocations, 60 * 60 * 1000);
}
