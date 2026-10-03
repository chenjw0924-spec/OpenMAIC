'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Github, Loader2, Mail, MailCheck } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { toast } from 'sonner';

/**
 * The sign-in page.
 *
 * Two channels, both configured server-side and reported by
 * /api/auth/session: email magic link (primary) and GitHub OAuth (backup).
 * A channel whose provider is not configured is hidden, so the page never
 * offers a sign-in that cannot work.
 *
 * `?verified=1` is where the magic-link and GitHub callback land after
 * setting the session cookie: the page then claims the browser's anonymous
 * guest library into the fresh account (POST /api/identity/claim) before
 * going home, so courses generated before sign-in follow the user.
 */
function LoginContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [providers, setProviders] = useState<{ email: boolean; github: boolean } | null>(null);
  const claimStarted = useRef(false);

  const verified = searchParams.get('verified') === '1';
  const error = searchParams.get('error');

  useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data) => setProviders(data.providers ?? { email: false, github: false }))
      .catch(() => setProviders({ email: false, github: false }));
  }, []);

  useEffect(() => {
    if (!verified || claimStarted.current) return;
    claimStarted.current = true;
    (async () => {
      try {
        // Merge the guest library into the account. A 409 means there was no
        // anonymous work to claim — not an error worth showing.
        const res = await fetch('/api/identity/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'claimed' && typeof data.moved === 'number' && data.moved > 0) {
            toast.success(t('auth.claimSuccess', { count: data.moved }));
          }
        }
      } catch {
        // Claim failures must not block sign-in; the work stays with the
        // anonymous owner and can be claimed by signing in again later.
      }
      router.replace('/');
    })();
  }, [verified, router, t]);

  const sendLink = async () => {
    const trimmed = email.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/auth/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      if (res.ok) {
        setSent(true);
      } else if (res.status === 502) {
        toast.error(t('auth.sendFailed'));
      } else {
        toast.error(t('auth.invalidEmail'));
      }
    } catch {
      toast.error(t('auth.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  if (verified) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-violet-500" />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('auth.signingIn')}</p>
      </div>
    );
  }

  const errorMessage =
    error === 'invalid_token'
      ? t('auth.errorInvalidToken')
      : error === 'oauth_state' || error === 'github'
        ? t('auth.errorGithub')
        : error
          ? t('auth.errorGeneric')
          : null;

  return (
    <div className="w-full max-w-sm">
      <button
        onClick={() => router.push('/')}
        className="mb-6 flex items-center gap-1.5 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('auth.backHome')}
      </button>

      <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border border-gray-100 dark:border-slate-800 rounded-2xl shadow-xl p-8">
        <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-1.5">
          {t('auth.title')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{t('auth.subtitle')}</p>

        {errorMessage && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50 text-sm text-red-600 dark:text-red-400">
            {errorMessage}
          </div>
        )}

        {providers?.email &&
          (sent ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <MailCheck className="w-8 h-8 text-violet-500" />
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {t('auth.sentTitle')}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                {t('auth.sentHint')}
              </p>
              <button
                onClick={() => setSent(false)}
                className="mt-1 text-xs text-violet-500 hover:text-violet-600 transition-colors"
              >
                {t('auth.resend')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendLink()}
                placeholder={t('auth.emailPlaceholder')}
                autoFocus
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-gray-800 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-600 outline-none focus:border-violet-400 dark:focus:border-violet-500 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-950 transition-all"
              />
              <button
                onClick={sendLink}
                disabled={sending || !email.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                {t('auth.sendLink')}
              </button>
            </div>
          ))}

        {providers?.email && providers?.github && (
          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200 dark:bg-slate-700" />
            <span className="text-xs text-gray-400 dark:text-gray-500">{t('auth.or')}</span>
            <div className="flex-1 h-px bg-gray-200 dark:bg-slate-700" />
          </div>
        )}

        {providers?.github && (
          <a
            href="/api/auth/github"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800 text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors"
          >
            <Github className="w-4 h-4" />
            {t('auth.continueGithub')}
          </a>
        )}

        {providers && !providers.email && !providers.github && (
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
            {t('auth.noProviders')}
          </p>
        )}
      </div>

      <p className="mt-5 text-center text-xs text-gray-400 dark:text-gray-600 leading-relaxed">
        {t('auth.guestNotice')}
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
      <Suspense
        fallback={
          <Loader2 className="w-6 h-6 animate-spin text-violet-500" />
        }
      >
        <LoginContent />
      </Suspense>
    </div>
  );
}