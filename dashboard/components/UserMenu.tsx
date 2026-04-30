'use client';

import { useEffect, useState } from 'react';
import { User, LogOut, ChevronDown } from 'lucide-react';

interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  // Headers-mode may surface additional claims (e.g. familyName, givenName).
  [claim: string]: string | undefined;
}

interface SessionData {
  authenticated: boolean;
  user: SessionUser | null;
  /** Where the Sign-out link should point. `null` means hide the link. */
  logoutUrl?: string | null;
}

// Validate picture URL to prevent XSS via javascript: or data: URIs
function isValidPictureUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function buildDisplayName(user: SessionUser): string {
  if (user.name) return user.name;
  const composed = [user.givenName, user.familyName].filter(Boolean).join(' ').trim();
  if (composed.length > 0) return composed;
  if (user.email) return user.email;
  if (user.preferredUsername) return user.preferredUsername;
  return user.sub || 'User';
}

export function UserMenu() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchSession() {
      try {
        const response = await fetch('/api/auth/session');
        if (!response.ok) {
          console.warn(`Session check failed: ${response.status} ${response.statusText}`);
          setSession({ authenticated: false, user: null, logoutUrl: null });
          return;
        }
        const data = await response.json();
        setSession(data);
      } catch (error) {
        // Log error for debugging but don't disrupt user experience
        console.warn('Failed to fetch session:', error);
        setSession({ authenticated: false, user: null, logoutUrl: null });
      } finally {
        setIsLoading(false);
      }
    }
    fetchSession();
  }, []);

  // Don't render anything while loading or if not authenticated
  if (isLoading || !session?.authenticated || !session.user) {
    return null;
  }

  const displayName = buildDisplayName(session.user);
  const headerName = session.user.name || buildDisplayName(session.user);
  const logoutUrl = session.logoutUrl ?? null;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors"
      >
        {isValidPictureUrl(session.user.picture) ? (
          <img src={session.user.picture} alt="" className="w-6 h-6 rounded-full" />
        ) : (
          <User className="w-5 h-5" />
        )}
        <span className="hidden sm:inline max-w-32 truncate">{displayName}</span>
        <ChevronDown className="w-4 h-4" />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          {/* Dropdown */}
          <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg py-1 z-20">
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-900 truncate">{headerName}</p>
              {session.user.email && (
                <p className="text-xs text-gray-500 truncate">{session.user.email}</p>
              )}
            </div>
            {logoutUrl && (
              <a
                href={logoutUrl}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
