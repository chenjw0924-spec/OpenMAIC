import { createLogger } from '@/lib/logger';
import {
  authSecret,
  githubOAuthConfig,
  OAUTH_STATE_COOKIE,
} from '@/lib/server/auth/config';
import { findOrCreateGithubUser } from '@/lib/server/auth/db';
import { exchangeGithubCode, fetchGithubProfile } from '@/lib/server/auth/github';
import { mintSessionToken, sessionCookieHeader } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

const log = createLogger('Auth');

function redirect(location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, 'cache-control': 'no-store' });
  for (const value of setCookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers });
}

function clearStateCookie(): string {
  const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
  return (
    `${OAUTH_STATE_COOKIE}=; Path=/api/auth/github; HttpOnly; SameSite=Lax; Max-Age=0` +
    (secure ? '; Secure' : '')
  );
}

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * `GET /api/auth/github/callback` — finish the GitHub OAuth flow.
 *
 * Verifies the CSRF state against the cookie set at the start, exchanges the
 * code for an access token, reads the profile (id, verified primary email,
 * name, avatar), finds-or-creates the user — linking to an existing email
 * account when the verified address matches — and starts the session.
 * Failures land on /login with an error the page can show.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const config = githubOAuthConfig();
  const secret = authSecret();
  if (!config || !secret) return new Response('Not found', { status: 404 });

  const stateCookie = readCookie(request.headers, OAUTH_STATE_COOKIE);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!stateCookie || !state || stateCookie !== state || !code) {
    return redirect('/login?error=oauth_state', [clearStateCookie()]);
  }

  try {
    const accessToken = await exchangeGithubCode(config, code, `${url.origin}/api/auth/github/callback`);
    const profile = await fetchGithubProfile(accessToken);
    const user = await findOrCreateGithubUser(profile);
    return redirect('/login?verified=1', [
      clearStateCookie(),
      sessionCookieHeader(await mintSessionToken(user.id, secret)),
    ]);
  } catch (error) {
    log.error('GitHub sign-in failed', error);
    return redirect('/login?error=github', [clearStateCookie()]);
  }
}