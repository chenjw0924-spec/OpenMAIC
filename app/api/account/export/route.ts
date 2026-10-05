import { NextRequest } from 'next/server';
import { exportAccountData } from '@/lib/server/auth/account-data';
import { getAuthenticatedUser } from '@/lib/server/auth/request';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return Response.json({ error: 'Sign-in required' }, { status: 401 });
  try {
    const data = await exportAccountData(user);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="kestack-account-export.json"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[account-export] failed', error);
    return Response.json({ error: 'Account export failed' }, { status: 500 });
  }
}
