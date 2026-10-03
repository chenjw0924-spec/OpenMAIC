import { authSecret } from '@/lib/server/auth/config';
import { consumeEmailToken, findOrCreateEmailUser } from '@/lib/server/auth/db';
import { mintSessionToken, sessionCookieHeader } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, 'cache-control': 'no-store' });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers });
}

/**
 * `GET /api/auth/verify?token=...` — redeem a magic link.
 *
 * On success the user is created on first use, the session cookie is set and
 * the browser lands on /login?verified=1, where the page claims any
 * anonymous work (POST /api/identity/claim) and goes home. On failure it
 * lands back on the login page with an error it can show. The token is
 * single-use either way (consumed on read).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const secret = authSecret();
  if (!secret || !token) return redirect('/login?error=invalid_token');

  try {
    const email = await consumeEmailToken(token);
    if (!email) return redirect('/login?error=invalid_token');
    const user = await findOrCreateEmailUser(email);
    return redirect('/login?verified=1', sessionCookieHeader(await mintSessionToken(user.id, secret)));
  } catch {
    return redirect('/login?error=server');
  }
}