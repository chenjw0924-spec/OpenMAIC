import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { accountOwnerId } from './request';
import type { AuthUser } from './db';

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [table],
  );
  return result.rows[0]?.present === true;
}

async function optionalRows<T>(db: Queryable, table: string, sql: string, params: unknown[] = []) {
  if (!(await tableExists(db, table))) return [] as T[];
  const result = await db.query(sql, params);
  return result.rows as T[];
}

export async function exportAccountData(user: AuthUser): Promise<Record<string, unknown>> {
  const ownerId = accountOwnerId(user.id);
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const stages = await optionalRows<{
    id: string;
    name: string;
    created_at: number;
    updated_at: number;
    stage: unknown;
    scenes: unknown[];
    is_public: boolean;
    published_at: number | null;
  }>(
    pool,
    'stage_meta',
    `SELECT s.id, s.name, s.created_at, s.updated_at, s.data AS stage,
            COALESCE(jsonb_agg(sc.data ORDER BY sc.scene_order) FILTER (WHERE sc.id IS NOT NULL), '[]') AS scenes,
            m.is_public, m.published_at
       FROM stage_meta m
       JOIN document_stages s ON s.id = m.stage_id
       LEFT JOIN document_scenes sc ON sc.stage_id = s.id
      WHERE m.owner_id = $1 AND m.deleted_at IS NULL
      GROUP BY s.id, m.is_public, m.published_at
      ORDER BY s.created_at, s.id`,
    [ownerId],
  );
  const folders = await optionalRows(
    pool,
    'document_folders',
    'SELECT id, name, folder_order, created_at, updated_at FROM document_folders WHERE owner_id = $1 ORDER BY folder_order, id',
    [ownerId],
  );
  const materials = await optionalRows(
    pool,
    'owner_material',
    `SELECT id, kind, derived_from, mime, bytes, original_name, sha256, status,
            extraction, created_at, deleted_at
       FROM owner_material WHERE owner_id = $1 ORDER BY created_at, id`,
    [ownerId],
  );
  const sessions = await optionalRows(
    pool,
    'agent_sessions',
    `SELECT id, prompt, title, stage_id, skill_id, origin, status, created_at, updated_at, deleted_at
       FROM agent_sessions WHERE owner_id = $1 ORDER BY created_at, id`,
    [ownerId],
  );
  const classrooms = await optionalRows(
    pool,
    'kestack_classrooms',
    `SELECT id, stage, scenes, created_at, reserved FROM kestack_classrooms
      WHERE owner_id = $1 ORDER BY created_at, id`,
    [ownerId],
  );

  return {
    exportedAt: new Date().toISOString(),
    product: 'KeStack',
    account: { id: user.id, email: user.email, name: user.name, image: user.image },
    courses: stages,
    folders,
    materials,
    agentSessions: sessions,
    generatedClassrooms: classrooms,
    notes: [
      'API keys and provider credentials are not stored in the account export.',
      'Browser-local cache and preferences must be cleared separately from Settings.',
    ],
  };
}

export async function deleteAccountData(user: AuthUser): Promise<void> {
  const ownerId = accountOwnerId(user.id);
  const assetPrincipal = `owner:${ownerId}`;
  const { pool, withTransaction } = await getServerPersistenceProvider(
    process.env.DATABASE_URL ?? '',
  );
  const materialKeys = (
    await optionalRows<{ oss_key: string }>(
      pool,
      'owner_material',
      `SELECT oss_key FROM owner_material WHERE owner_id = $1 AND oss_key <> ''`,
      [ownerId],
    )
  ).map((row) => row.oss_key);

  // Remove external/object-store bytes before deleting the metadata. A failed
  // object deletion must leave the account retryable instead of reporting a
  // successful privacy deletion while bytes remain accessible.
  const byteStore = getMaterialByteStore();
  await Promise.all(materialKeys.map((key) => byteStore.delete(key)));

  await withTransaction(async (db) => {
    const stageRows = await optionalRows<{ stage_id: string }>(
      db,
      'stage_meta',
      'SELECT stage_id FROM stage_meta WHERE owner_id = $1',
      [ownerId],
    );
    const stageIds = stageRows.map((row) => row.stage_id);

    if (stageIds.length > 0) {
      for (const table of [
        'document_asset_refs',
        'document_asset_withdrawals',
        'document_scene_revision',
        'document_stage_revision',
        'runtime_sessions',
      ]) {
        if (await tableExists(db, table)) {
          await db.query(`DELETE FROM ${table} WHERE stage_id = ANY($1::text[])`, [stageIds]);
        }
      }
      if (await tableExists(db, 'document_stages')) {
        await db.query('DELETE FROM document_stages WHERE id = ANY($1::text[])', [stageIds]);
      }
    }

    const ownerTables = [
      'document_folders',
      'stage_meta',
      'agent_user_skill',
      'agent_owner_session_events',
      'agent_owner_session_event_counters',
      'agent_sessions',
      'owner_material',
      'legacy_import_bindings',
      'owner_merges',
      'kestack_classroom_media',
      'kestack_classroom_jobs',
      'kestack_classrooms',
    ];
    for (const table of ownerTables) {
      if (!(await tableExists(db, table))) continue;
      const column = table === 'owner_merges' ? 'from_owner_id' : 'owner_id';
      if (table === 'owner_merges') {
        await db.query('DELETE FROM owner_merges WHERE from_owner_id = $1 OR to_owner_id = $1', [
          ownerId,
        ]);
      } else {
        await db.query(`DELETE FROM ${table} WHERE ${column} = $1`, [ownerId]);
      }
    }

    if (await tableExists(db, 'runtime_sessions')) {
      await db.query('DELETE FROM runtime_sessions WHERE learner_key = $1', [ownerId]);
    }

    if (await tableExists(db, 'asset_entries')) {
      const deleted = await db.query<Record<string, unknown>>(
        'DELETE FROM asset_entries WHERE principal = $1 RETURNING content_hash',
        [assetPrincipal],
      );
      const hashes = deleted.rows
        .map((row) => row.content_hash)
        .filter((hash): hash is string => typeof hash === 'string');
      if (hashes.length > 0 && (await tableExists(db, 'asset_blobs'))) {
        await db.query(
          `DELETE FROM asset_blobs b
            WHERE b.content_hash = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM asset_entries e WHERE e.content_hash = b.content_hash)`,
          [hashes],
        );
      }
    }

    await db.query('DELETE FROM openmaic_auth_accounts WHERE user_id = $1', [user.id]);
    await db.query('DELETE FROM openmaic_auth_users WHERE id = $1', [user.id]);
  });
}
