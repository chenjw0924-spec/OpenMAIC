import type { Queryable } from '@openmaic/storage/document/pg';

/** PostgreSQL byte store for uploaded study materials on serverless hosts. */
export const MATERIAL_BYTE_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS kestack_material_bytes (
  object_key TEXT PRIMARY KEY,
  mime TEXT,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function ensureMaterialByteSchema(queryable: Queryable): Promise<void> {
  for (const statement of MATERIAL_BYTE_PG_SCHEMA.split(';')) {
    const sql = statement.trim();
    if (sql) await queryable.query(sql);
  }
}
