import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { authCookieSecure, SESSION_COOKIE, SESSION_TTL_SECONDS } from './config';

/**
 * The account session credential: a stateless HMAC-signed cookie.
 *
 * Format: `base64url(payload).base64url(signature)` where payload is
 * `{ uid, exp }` (expiry as unix seconds) and the signature is
 * HMAC-SHA256 over the payload segment with AUTH_SECRET. No server-side
 * session table: the cookie is the session, which keeps sign-in free of
 * database reads on the per-request identity path. Revocation is expiry
 * (30 days) plus rotation of AUTH_SECRET.
 */

export interface SessionPayload {
  /** The auth user id (a UUID); the owner id is `user:<uid>`. */
  readonly uid: string;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadSegment: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url');
}

/** Mint a session token for `uid`, valid for `ttlSeconds` from now. */
export function mintSessionToken(
  uid: string,
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): string {
  const payloadSegment = base64url(
    JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  );
  return `${payloadSegment}.${sign(payloadSegment, secret)}`;
}

/**
 * Verify a session token: the payload when the signature matches and the
 * token has not expired; `undefined` for anything else (absent, malformed,
 * forged, expired). Never throws: a bad cookie means "not signed in".
 */
export function verifySessionToken(token: string, secret: string): SessionPayload | undefined {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const payloadSegment = token.slice(0, dot);
  const expected = Buffer.from(sign(payloadSegment, secret));
  const actual = Buffer.from(token.slice(dot + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    );
    if (!payload || typeof payload !== 'object') return undefined;
    const { uid, exp } = payload as { uid?: unknown; exp?: unknown };
    if (typeof uid !== 'string' || typeof exp !== 'number') return undefined;
    if (exp * 1000 <= Date.now()) return undefined;
    return { uid, exp };
  } catch {
    return undefined;
  }
}

function cookieAttributes(): string {
  const secure = authCookieSecure() ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** The `Set-Cookie` value establishing `token` as the session. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes()}; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** The `Set-Cookie` value dropping the session cookie (sign-out). */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes()}; Max-Age=0`;
}

/** A fresh magic-link token: the raw value goes in the email, only its hash is stored. */
export function mintEmailToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a magic-link token. */
export function hashEmailToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A random OAuth state value (CSRF token for the GitHub round-trip). */
export function mintOAuthState(): string {
  return randomBytes(16).toString('base64url');
}