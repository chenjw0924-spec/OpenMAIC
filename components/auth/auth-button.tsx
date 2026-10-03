'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn, LogOut, UserRound } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

interface SessionUser {
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

/**
 * The home header's account control.
 *
 * Signed out: a sign-in icon button leading to /login. Signed in: the
 * account avatar (or an initial) opening a small menu with the account's
 * email and a sign-out action. The session is fetched once on mount; a
 * signed-out visitor costs one cheap JSON request.
 *
 * Renders nothing until the session answer arrives, so the pill does not
 * shift under the user's cursor on first paint.
 */
export function AuthButton() {
  const { t } = useI18n();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setUser(data.user ?? null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  if (!loaded) return null;

  if (!user) {
    return (
      <button
        onClick={() => router.push('/login')}
        className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
        title={t('auth.signIn')}
        aria-label={t('auth.signIn')}
      >
        <LogIn className="w-4 h-4" />
      </button>
    );
  }

  const initial = (user.name ?? user.email ?? '?').trim().charAt(0).toUpperCase() || '?';

  const signOut = async () => {
    setMenuOpen(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Reload so every owner-scoped store refetches as the guest identity.
      window.location.href = '/';
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setMenuOpen((open) => !open)}
        className={cn(
          'size-7 rounded-full overflow-hidden flex items-center justify-center transition-all',
          'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-300 text-xs font-bold',
          'hover:ring-2 hover:ring-violet-300 dark:hover:ring-violet-700',
          menuOpen && 'ring-2 ring-violet-400 dark:ring-violet-600',
        )}
        title={user.email ?? user.name ?? t('auth.account')}
        aria-label={t('auth.account')}
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- external avatar URL
          <img src={user.image} alt="" className="size-full object-cover" />
        ) : (
          initial
        )}
      </button>
      {menuOpen && (
        <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
              {user.name ?? t('auth.account')}
            </p>
            {user.email && (
              <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
            )}
          </div>
          <button
            onClick={signOut}
            className="w-full px-4 py-2 text-left text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            {t('auth.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}