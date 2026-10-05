import { authSecret, SESSION_COOKIE } from './config';
import { findUserById, type AuthUser } from './db';
import { verifySessionToken } from './session';

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator >= 0 && item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export async function getAuthenticatedUser(request: Request): Promise<AuthUser | null> {
  const secret = authSecret();
  const token = readCookie(request.headers, SESSION_COOKIE);
  if (!secret || !token) return null;
  const session = await verifySessionToken(token, secret);
  return session ? ((await findUserById(session.uid)) ?? null) : null;
}

export function accountOwnerId(userId: string): string {
  return `user:${userId}`;
}
