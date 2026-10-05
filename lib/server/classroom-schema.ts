import type { Queryable } from '@openmaic/storage/document/pg';

/** Idempotent PostgreSQL schema for generated classrooms, media, and jobs. */
export const CLASSROOM_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS kestack_classrooms (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  stage JSONB NOT NULL,
  scenes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS kestack_classrooms_owner_idx ON kestack_classrooms (owner_id);
CREATE TABLE IF NOT EXISTS kestack_classroom_media (
  classroom_id TEXT NOT NULL,
  media_path TEXT NOT NULL,
  owner_id TEXT,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (classroom_id, media_path)
);
CREATE INDEX IF NOT EXISTS kestack_classroom_media_owner_idx
  ON kestack_classroom_media (owner_id);
CREATE TABLE IF NOT EXISTS kestack_classroom_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kestack_classroom_jobs_owner_idx
  ON kestack_classroom_jobs (owner_id);
`;

export async function ensureClassroomSchema(queryable: Queryable): Promise<void> {
  for (const statement of CLASSROOM_PG_SCHEMA.split(';')) {
    const sql = statement.trim();
    if (sql) await queryable.query(sql);
  }
}
