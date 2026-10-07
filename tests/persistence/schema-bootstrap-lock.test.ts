import { describe, expect, it, vi } from 'vitest';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import {
  SCHEMA_BOOTSTRAP_LOCK_KEY,
  withSchemaBootstrapLock,
} from '@/lib/persistence/schema-bootstrap-lock';

function fixture() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { client, pool: pool as unknown as ConnectableQueryable };
}

describe('pooler-safe schema bootstrap', () => {
  it('pins schema work and the advisory lock to one transaction', async () => {
    const { client, pool } = fixture();
    await expect(
      withSchemaBootstrapLock(pool, async (db) => {
        await db.query('CREATE TABLE example (id int)');
        return 'ready';
      }),
    ).resolves.toBe('ready');
    expect(client.query.mock.calls).toEqual([
      ['BEGIN'],
      ["SET LOCAL idle_in_transaction_session_timeout = '10s'"],
      ["SET LOCAL lock_timeout = '15s'"],
      ["SET LOCAL statement_timeout = '30s'"],
      ['SELECT pg_advisory_xact_lock($1::bigint)', [SCHEMA_BOOTSTRAP_LOCK_KEY]],
      ['CREATE TABLE example (id int)'],
      ['COMMIT'],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.removeListener).toHaveBeenCalledWith('error', client.on.mock.calls[0][1]);
  });

  it('discards a connection PostgreSQL terminates while the instance is idle', async () => {
    const { client, pool } = fixture();
    const error = new Error('terminating connection due to idle-in-transaction timeout');
    await withSchemaBootstrapLock(pool, async () => {
      const onError = client.on.mock.calls[0][1] as (error: Error) => void;
      onError(error);
    });
    expect(client.release).toHaveBeenCalledWith(error);
    expect(client.removeListener).toHaveBeenCalledWith('error', client.on.mock.calls[0][1]);
  });

  it('rolls back and releases the connection when initialization fails', async () => {
    const { client, pool } = fixture();
    const error = new Error('schema failure');
    await expect(
      withSchemaBootstrapLock(pool, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it('does not run schema work if bounded lock acquisition fails', async () => {
    const { client, pool } = fixture();
    const error = new Error('lock timeout');
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) throw error;
      return { rows: [] };
    });
    const body = vi.fn();
    await expect(withSchemaBootstrapLock(pool, body)).rejects.toBe(error);
    expect(body).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it('discards a connection when rollback fails and preserves the original error', async () => {
    const { client, pool } = fixture();
    const original = new Error('schema failure');
    const rollback = new Error('connection lost');
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollback;
      return { rows: [] };
    });
    await expect(
      withSchemaBootstrapLock(pool, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(client.release).toHaveBeenCalledWith(rollback);
  });
});
