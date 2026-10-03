import { authSecret, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/server/auth/config';
import {
  mintSessionToken,
  sessionCookieHeader,
  verifySessionToken,
} from '@/lib/server/auth/session';
import type {
  OwnerAuthMethod,
  OwnerAuthMethodResult,
  OwnerAuthRequest,
  OwnerPrincipal,
} from '@/lib/server/identity';
import { OWNER_ROLES } from '@/lib/server/identity';

/**
 * The account session method: OpenMAIC's own sign-in (email magic link,
 * GitHub OAuth — see lib/server/auth/ and app/api/auth/).
 *
 * It reads the `openmaic_session` cookie, an HMAC-signed token minted by the
 * auth routes. Registered users resolve to `user:<uuid>` with
 * `kind: 'user'` and the `course:publish` role, so they keep the abilities
 * single-user mode had; everyone else answers `not-applicable` and core
 * falls through to the anonymous cookie (guest mode).
 *
 * An expired or forged cookie also answers `not-applicable` rather than
 * `invalid`: the credential is absent for practical purposes, and refusing
 * the request with 401 would lock a signed-out browser out of guest mode
 * too. Only a token that verifies carries identity.
 *
 * Sessions are sliding: a token past half its lifetime is re-minted on the
 * response, so an active user stays signed in for 30 days after their last
 * visit rather than after their first.
 */

const USER_OWNER_PREFIX = 'user:';
/** Session cookie renewal threshold: re-mint once half the TTL has passed. */
const RENEW_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

const USER_ROLES: ReadonlySet<string> = new Set<string>([OWNER_ROLES.coursePublish]);

/** UUIDs minted by lib/server/auth/db.ts (crypto.randomUUID). */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function principalFor(uid: string): OwnerPrincipal {
  return {
    ownerId: `${USER_OWNER_PREFIX}${uid}`,
    kind: 'user',
    roles: USER_ROLES,
    assurance: 'verified',
    channel: 'web',
  };
}

function authenticateHeaders(headers: Headers): OwnerAuthMethodResult {
  const token = readSessionCookie(headers);
  if (!token) return { status: 'not-applicable' };
  const secret = authSecret();
  // Registration happens only with AUTH_SECRET set (instrumentation.ts), so
  // this is unreachable in a sane deployment; if it somehow happens, fail
  // rather than silently treating everyone as signed out.
  if (!secret) throw new Error('session auth method registered without AUTH_SECRET');
  const session = verifySessionToken(token, secret);
  if (!session) return { status: 'not-applicable' };
  const ageSeconds = SESSION_TTL_SECONDS - (session.exp - Math.floor(Date.now() / 1000));
  return {
    status: 'authenticated',
    principal: principalFor(session.uid),
    ...(ageSeconds >= RENEW_AFTER_SECONDS
      ? { setCookies: [sessionCookieHeader(mintSessionToken(session.uid, secret))] }
      : {}),
  };
}

export function sessionAuthMethod(): OwnerAuthMethod {
  return {
    name: 'session',
    authenticate: async (req: OwnerAuthRequest) => authenticateHeaders(req.headers),
    authenticateFromContext: async () => {
      // Server Actions have no Request: read (and, when renewing, write) the
      // cookie through next/headers, per the method contract.
      const { cookies } = await import('next/headers');
      const cookieStore = await cookies();
      const token = cookieStore.get(SESSION_COOKIE)?.value;
      if (!token) return { status: 'not-applicable' };
      const secret = authSecret();
      if (!secret) throw new Error('session auth method registered without AUTH_SECRET');
      const session = verifySessionToken(token, secret);
      if (!session) return { status: 'not-applicable' };
      const ageSeconds = SESSION_TTL_SECONDS - (session.exp - Math.floor(Date.now() / 1000));
      if (ageSeconds >= RENEW_AFTER_SECONDS) {
        try {
          cookieStore.set(SESSION_COOKIE, mintSessionToken(session.uid, secret), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: SESSION_TTL_SECONDS,
            secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0',
          });
        } catch {
          // Not writable here (a render, not an action): skip the renewal.
        }
      }
      return { status: 'authenticated', principal: principalFor(session.uid) };
    },
    describeStoredOwner: (ownerId) =>
      ownerId.slice(0, USER_OWNER_PREFIX.length) === USER_OWNER_PREFIX &&
      USER_ID_PATTERN.test(ownerId.slice(USER_OWNER_PREFIX.length))
        ? { kind: 'user', roles: USER_ROLES }
        : undefined,
  };
}