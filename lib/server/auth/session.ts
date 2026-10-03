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
 *
 * Implemented on the Web Crypto API (`globalThis.crypto`), not node:crypto:
 * instrumentation.ts's import graph is bundled into the Edge middleware
 * function, which forbids Node builtins (the same constraint as
 * lib/server/identity/anonymous-cookie.ts).
 */

export interface SessionPayload {
  /** The auth user id (a UUID); the owner id is `user:<uid>`. */
  readonly uid: string;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Runtime-agnostic base64url (Buffer and btoa are not both available everywhere). */
function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    if (b !== undefined) out += B64_ALPHABET[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    if (c !== undefined) out += B64_ALPHABET[c & 63];
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(input: string): Uint8Array | undefined {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4).padEnd(4, '=');
    const n =
      (B64_ALPHABET.indexOf(chunk[0]!) << 18) |
      (B64_ALPHABET.indexOf(chunk[1]!) << 12) |
      ((chunk[2] === '=' ? 0 : B64_ALPHABET.indexOf(chunk[2]!)) << 6) |
      (chunk[3] === '=' ? 0 : B64_ALPHABET.indexOf(chunk[3]!));
    bytes.push((n >> 16) & 0xff);
    if (chunk[2] !== '=') bytes.push((n >> 8) & 0xff);
    if (chunk[3] !== '=') bytes.push(n & 0xff);
  }
  return new Uint8Array(bytes);
}

/** Imported HMAC keys by secret, so verification does not re-import per request. */
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

async function sign(payloadSegment: string, secret: string): Promise<Uint8Array> {
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(payloadSegment),
  );
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Mint a session token for `uid`, valid for `ttlSeconds` from now. */
export async function mintSessionToken(
  uid: string,
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const payloadSegment = base64urlEncode(
    encoder.encode(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + ttlSeconds })),
  );
  return `${payloadSegment}.${base64urlEncode(await sign(payloadSegment, secret))}`;
}

/**
 * Verify a session token: the payload when the signature matches and the
 * token has not expired; `undefined` for anything else (absent, malformed,
 * forged, expired). Never throws: a bad cookie means "not signed in".
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | undefined> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const payloadSegment = token.slice(0, dot);
  const actual = base64urlDecode(token.slice(dot + 1));
  if (!actual) return undefined;
  const expected = await sign(payloadSegment, secret);
  if (!timingSafeEqual(expected, actual)) return undefined;
  try {
    const payloadBytes = base64urlDecode(payloadSegment);
    if (!payloadBytes) return undefined;
    const payload: unknown = JSON.parse(decoder.decode(payloadBytes));
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
  return base64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** The stored form of a magic-link token. */
export async function hashEmailToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random OAuth state value (CSRF token for the GitHub round-trip). */
export function mintOAuthState(): string {
  return base64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}