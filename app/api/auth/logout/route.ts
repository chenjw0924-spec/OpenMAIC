import { clearSessionCookieHeader } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

/**
 * `POST /api/auth/logout` — drop the session cookie.
 *
 * POST rather than GET so a stray prefetch cannot sign anyone out. The
 * anonymous identity is untouched: after sign-out the browser keeps its
 * guest library (which is empty when the pre-sign-in guest work was claimed
 * into the account).
 */
export async function POST(): Promise<Response> {
  return Response.json(
    { ok: true },
    {
      headers: {
        'cache-control': 'no-store',
        'Set-Cookie': clearSessionCookieHeader(),
      },
    },
  );
}