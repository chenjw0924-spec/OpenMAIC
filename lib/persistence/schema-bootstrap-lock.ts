import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { PoolClient } from 'pg';

/**
 * PostgreSQL advisory-lock key serializing schema bootstrap across processes.
 * Any fixed value works; it only has to be the same in every instance of this
 * application and distinct from the keys the storage package's test suites
 * take.
 */
// v2 does not wait on session locks leaked by older deployments through a pooler.
export const SCHEMA_BOOTSTRAP_LOCK_KEY = 71_310_524;

/**
 * Run a schema bootstrap with every other instance's bootstrap held off.
 *
 * `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and
 * `CREATE OR REPLACE FUNCTION` are not atomic across sessions: two instances
 * starting together against the same database can both decide an object is
 * missing and one fails on the catalog's unique index (or with "tuple
 * concurrently updated"), which answers its first request with a 500. The
 * statements are idempotent one at a time, so running the bootstraps one
 * after another is all it takes.
 *
 * The lock is transaction-level: BEGIN pins the backend even behind a Neon
 * transaction pooler. A session-level lock acquired in autocommit mode can
 * otherwise be unlocked on a different backend and leak indefinitely. It lives
 * here, at the
 * application's bootstrap, rather than in each package `ensure*Schema`
 * function, because what must be serialized is the whole sequence -- package
 * tables and this application's own (`stage_meta`, owner materials) alike --
 * and every caller that provisions schema goes through this one helper.
 */
export async function withSchemaBootstrapLock<T>(
  pool: ConnectableQueryable,
  body: (queryable: Queryable) => Promise<T>,
): Promise<T> {
  // Application callers use node-postgres pools, whose release accepts an error
  // to discard a broken connection; the storage interface omits that argument.
  const client = (await pool.connect()) as Queryable &
    Pick<PoolClient, 'release'> &
    Partial<Pick<PoolClient, 'on' | 'removeListener'>>;
  let releaseError: Error | undefined;
  const onClientError = (error: Error) => {
    releaseError ??= error;
  };
  client.on?.('error', onClientError);
  try {
    await client.query('BEGIN');
    try {
      // A suspended serverless instance must not hold the lock indefinitely
      // between queries. PostgreSQL enforces this even while JS is frozen.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SCHEMA_BOOTSTRAP_LOCK_KEY]);
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error('Rollback failed');
      }
      throw error;
    }
  } catch (error) {
    releaseError ??= error instanceof Error ? error : new Error('Schema bootstrap failed');
    throw error;
  } finally {
    client.removeListener?.('error', onClientError);
    client.release(releaseError);
  }
}
