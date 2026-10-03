import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { EMAIL_RESEND_COOLDOWN_MS, EMAIL_TOKEN_TTL_MS } from './config';
import { hashEmailToken, mintEmailToken } from './session';

/**
 * The account store: three small tables in the same PostgreSQL database the
 * courses live in.
 *
 * - `openmaic_auth_users`: one row per person. `email` is nullable because a
 *    GitHub account may have no verified email on file.
 * - `openmaic_auth_accounts`: one row per (provider, external id) bound to a
 *    user — the email address itself for email sign-in, the numeric GitHub
 *    id for GitHub sign-in. This is what lets one person later hold both.
 * - `openmaic_auth_email_tokens`: pending magic links, stored hashed,
 *    single-use, 15-minute expiry, one active token per email (a resend
 *    replaces the row).
 *
 * Schema creation follows the project's own pattern (`ensure*Schema` in the
 * storage packages): CREATE TABLE IF NOT EXISTS behind a memoized promise,
 * so a cold serverless instance does it once and every later call reuses it.
 * The pool is process-global like lib/persistence/server-provider.ts.
 */

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
}

interface AuthDbState {
  pool?: Pool;
  schemaPromise?: Promise<void>;
}

const AUTH_DB_KEY = Symbol.for('openmaic.auth.db');
const globalState = globalThis as typeof globalThis & { [AUTH_DB_KEY]?: AuthDbState };
const state = (): AuthDbState => (globalState[AUTH_DB_KEY] ??= {});

async function createPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; the account store needs the same database.');
  }
  const { Pool } = await import('pg');
  return new Pool({ connectionString, max: 3 });
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS openmaic_auth_users (
      id text PRIMARY KEY,
      email text UNIQUE,
      name text,
      image text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS openmaic_auth_accounts (
      user_id text NOT NULL REFERENCES openmaic_auth_users(id) ON DELETE CASCADE,
      provider text NOT NULL,
      provider_account_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, provider_account_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS openmaic_auth_email_tokens (
      email text PRIMARY KEY,
      token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function db(): Promise<Pool> {
  const current = state();
  current.pool ??= await createPool();
  current.schemaPromise ??= ensureSchema(current.pool).catch((error) => {
    // A failed bootstrap (e.g. a transient cold-start error) must not be
    // memoized: the next request tries again.
    state().schemaPromise = undefined;
    throw error;
  });
  await current.schemaPromise;
  return current.pool;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, name: row.name, image: row.image };
}

export async function findUserByEmail(email: string): Promise<AuthUser | undefined> {
  const pool = await db();
  const result = await pool.query<UserRow>(
    'SELECT id, email, name, image FROM openmaic_auth_users WHERE email = $1',
    [email],
  );
  return result.rows[0] ? toAuthUser(result.rows[0]) : undefined;
}

export async function findUserByAccount(
  provider: string,
  providerAccountId: string,
): Promise<AuthUser | undefined> {
  const pool = await db();
  const result = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.name, u.image
     FROM openmaic_auth_users u
     JOIN openmaic_auth_accounts a ON a.user_id = u.id
     WHERE a.provider = $1 AND a.provider_account_id = $2`,
    [provider, providerAccountId],
  );
  return result.rows[0] ? toAuthUser(result.rows[0]) : undefined;
}

export async function findUserById(id: string): Promise<AuthUser | undefined> {
  const pool = await db();
  const result = await pool.query<UserRow>(
    'SELECT id, email, name, image FROM openmaic_auth_users WHERE id = $1',
    [id],
  );
  return result.rows[0] ? toAuthUser(result.rows[0]) : undefined;
}

async function linkAccount(client: Pool | PoolClient, userId: string, provider: string, providerAccountId: string): Promise<void> {
  await client.query(
    `INSERT INTO openmaic_auth_accounts (user_id, provider, provider_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_account_id) DO NOTHING`,
    [userId, provider, providerAccountId],
  );
}

/**
 * The user behind an email sign-in, creating the account on first use. A
 * later GitHub sign-in with the same verified email lands on the same user
 * (see findOrCreateGithubUser).
 */
export async function findOrCreateEmailUser(email: string): Promise<AuthUser> {
  const existing = await findUserByEmail(email);
  if (existing) {
    const pool = await db();
    await pool.query('UPDATE openmaic_auth_users SET last_login_at = now() WHERE id = $1', [
      existing.id,
    ]);
    return existing;
  }
  const pool = await db();
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO openmaic_auth_users (id, email, name) VALUES ($1, $2, $3)',
      [id, email, email.split('@')[0] ?? null],
    );
    await linkAccount(client, id, 'email', email);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // A concurrent first sign-in with the same email lost the race: read it.
    const raced = await findUserByEmail(email);
    if (raced) return raced;
    throw error;
  } finally {
    client.release();
  }
  return { id, email, name: email.split('@')[0] ?? null, image: null };
}

/**
 * The user behind a GitHub sign-in: the linked account when seen before;
 * otherwise the user with the same verified email (linking GitHub to it);
 * otherwise a fresh user. `email` may be null when GitHub has no verified
 * address for the account.
 */
export async function findOrCreateGithubUser(profile: {
  githubId: string;
  email: string | null;
  name: string | null;
  image: string | null;
}): Promise<AuthUser> {
  const linked = await findUserByAccount('github', profile.githubId);
  if (linked) {
    const pool = await db();
    await pool.query('UPDATE openmaic_auth_users SET last_login_at = now() WHERE id = $1', [
      linked.id,
    ]);
    return linked;
  }
  if (profile.email) {
    const byEmail = await findUserByEmail(profile.email);
    if (byEmail) {
      const pool = await db();
      await linkAccount(pool, byEmail.id, 'github', profile.githubId);
      await pool.query('UPDATE openmaic_auth_users SET last_login_at = now() WHERE id = $1', [
        byEmail.id,
      ]);
      return byEmail;
    }
  }
  const pool = await db();
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO openmaic_auth_users (id, email, name, image) VALUES ($1, $2, $3, $4)',
      [id, profile.email, profile.name, profile.image],
    );
    await linkAccount(client, id, 'github', profile.githubId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const raced = await findUserByAccount('github', profile.githubId);
    if (raced) return raced;
    throw error;
  } finally {
    client.release();
  }
  return { id, email: profile.email, name: profile.name, image: profile.image };
}

export type EmailTokenIssue =
  | { readonly status: 'sent'; readonly token: string }
  | { readonly status: 'cooldown' };

/**
 * Store a fresh magic-link token for `email` and return it for sending.
 * Inside the resend window the previous token is still fresh, so nothing is
 * stored and no mail should go out — the caller answers the same success
 * either way, which also keeps the endpoint from revealing send timing.
 */
export async function issueEmailToken(email: string): Promise<EmailTokenIssue> {
  const pool = await db();
  const existing = await pool.query<{ created_at: Date }>(
    'SELECT created_at FROM openmaic_auth_email_tokens WHERE email = $1',
    [email],
  );
  if (
    existing.rows[0] &&
    Date.now() - existing.rows[0].created_at.getTime() < EMAIL_RESEND_COOLDOWN_MS
  ) {
    return { status: 'cooldown' };
  }
  const token = mintEmailToken();
  await pool.query(
    `INSERT INTO openmaic_auth_email_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')
     ON CONFLICT (email) DO UPDATE SET
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       created_at = now()`,
    [email, await hashEmailToken(token)],
  );
  return { status: 'sent', token };
}

/**
 * Redeem a magic-link token: the email it was issued for when the hash
 * matches and the token is unexpired. The token is single-use — consumed
 * rows are deleted whether or not they were still valid, so a leaked link
 * cannot be replayed and a used one cannot linger.
 */
export async function consumeEmailToken(token: string): Promise<string | undefined> {
  const pool = await db();
  const result = await pool.query<{ email: string; expires_at: Date }>(
    'DELETE FROM openmaic_auth_email_tokens WHERE token_hash = $1 RETURNING email, expires_at',
    [await hashEmailToken(token)],
  );
  const row = result.rows[0];
  if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
  return row.email;
}

/** Housekeeping for expired tokens; called from issueEmailToken's path. */
export async function deleteExpiredEmailTokens(): Promise<void> {
  const pool = await db();
  await pool.query('DELETE FROM openmaic_auth_email_tokens WHERE expires_at <= now()');
}

export { EMAIL_TOKEN_TTL_MS };