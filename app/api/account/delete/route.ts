import { NextRequest } from 'next/server';
import { deleteAccountData } from '@/lib/server/auth/account-data';
import { getAuthenticatedUser } from '@/lib/server/auth/request';
import { clearSessionCookieHeader } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return Response.json({ error: 'Sign-in required' }, { status: 401 });
  let body: { confirmation?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Confirmation is required' }, { status: 400 });
  }
  if (body.confirmation !== 'DELETE') {
    return Response.json({ error: 'Type DELETE to confirm account deletion' }, { status: 400 });
  }
  try {
    await deleteAccountData(user);
    return Response.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookieHeader() } },
    );
  } catch (error) {
    console.error('[account-delete] failed', error);
    return Response.json({ error: 'Account deletion failed' }, { status: 500 });
  }
}
