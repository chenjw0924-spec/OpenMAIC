import { authSecret, emailAuthEnabled, githubAuthEnabled, SESSION_COOKIE } from '@/lib/server/auth/config';
import { findUserById } from '@/lib/server/auth/db';
import { verifySessionToken } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

function readSessionCookie(headers: Headers): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * `GET /api/auth/session` — who is signed in, and which sign-in providers
 * this deployment offers. The header button polls this on mount; the login
 * page uses `providers` to hide channels that are not configured.
 *
 * Always 200 (an unsigned visitor is `{ user: null }`, not an error).
 */
export async function GET(request: Request): Promise<Response> {
  const providers = { email: emailAuthEnabled(), github: githubAuthEnabled() };
  const secret = authSecret();
  const token = readSessionCookie(request.headers);
  const session = secret && token ? await verifySessionToken(token, secret) : undefined;
  if (!session) {
    return Response.json(
      { user: null, providers },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const user = await findUserById(session.uid);
  // A user deleted out from under a live cookie reads as signed out.
  return Response.json(
    {
      user: user
        ? { name: user.name, email: user.email, image: user.image }
        : null,
      providers,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}