import { githubOAuthConfig, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from '@/lib/server/auth/config';
import { githubAuthorizeUrl } from '@/lib/server/auth/github';
import { mintOAuthState } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

/**
 * `GET /api/auth/github` — start the GitHub OAuth flow.
 *
 * Redirects to GitHub's authorize page with a CSRF state kept in a
 * short-lived HttpOnly cookie; the callback matches them. Answers 404 when
 * the provider is not configured, so a deployment without GitHub credentials
 * simply has no GitHub sign-in.
 */
export async function GET(request: Request): Promise<Response> {
  const config = githubOAuthConfig();
  if (!config) return new Response('Not found', { status: 404 });

  const state = mintOAuthState();
  const callbackUrl = `${new URL(request.url).origin}/api/auth/github/callback`;
  const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
  const headers = new Headers({
    Location: githubAuthorizeUrl(config, callbackUrl, state),
    'cache-control': 'no-store',
  });
  headers.append(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${state}; Path=/api/auth/github; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${OAUTH_STATE_TTL_SECONDS}${secure ? '; Secure' : ''}`,
  );
  return new Response(null, { status: 302, headers });
}