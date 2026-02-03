'use client';

import { useEffect, useState } from 'react';
import { User, LogOut, ChevronDown } from 'lucide-react';

interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

interface SessionData {
  authenticated: boolean;
  user: SessionUser | null;
}

export function UserMenu() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchSession() {
      try {
        const response = await fetch('/api/auth/session');
        const data = await response.json();
        setSession(data);
      } catch {
        setSession({ authenticated: false, user: null });
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

  const displayName = session.user.name || session.user.email || 'User';

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors"
      >
        {session.user.picture ? (
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
              <p className="text-sm font-medium text-gray-900 truncate">
                {session.user.name || 'User'}
              </p>
              {session.user.email && (
                <p className="text-xs text-gray-500 truncate">{session.user.email}</p>
              )}
            </div>
            <a
              href="/api/auth/logout"
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </a>
          </div>
        </>
      )}
    </div>
  );
}
