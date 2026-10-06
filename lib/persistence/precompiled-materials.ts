import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

export const PRECOMPILED_MATERIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS precompiled_material (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_bytes BIGINT NOT NULL,
  page_count INTEGER NOT NULL,
  extractor_version TEXT NOT NULL,
  text TEXT NOT NULL,
  pages JSONB NOT NULL,
  chapters JSONB NOT NULL,
  chunks JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS precompiled_material_status_idx
  ON precompiled_material (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS precompiled_material_sha256_idx
  ON precompiled_material (source_sha256);
`;

export async function ensurePrecompiledMaterialSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(PRECOMPILED_MATERIAL_SCHEMA)) {
    await queryable.query(statement);
  }
}

export interface PrecompiledMaterialPage {
  page: number;
  text: string;
}

export interface PrecompiledMaterialChapter {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  text: string;
}

export interface PrecompiledMaterialChunk {
  id: string;
  text: string;
  startPage: number;
  endPage: number;
  chapterId?: string;
}

export interface PrecompiledMaterialRecord {
  id: string;
  slug: string;
  title: string;
  originalName: string;
  mime: string;
  sourceSha256: string;
  sourceBytes: number;
  pageCount: number;
  extractorVersion: string;
  text: string;
  pages: PrecompiledMaterialPage[];
  chapters: PrecompiledMaterialChapter[];
  chunks: PrecompiledMaterialChunk[];
  status: 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface PrecompiledMaterialSummary extends Omit<
  PrecompiledMaterialRecord,
  'text' | 'pages' | 'chapters' | 'chunks'
> {
  textChars: number;
  chunkCount: number;
  chapterCount: number;
}

interface RawPrecompiledMaterialRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  original_name: string;
  mime: string;
  source_sha256: string;
  source_bytes: number | string;
  page_count: number | string;
  extractor_version: string;
  text: string;
  pages: unknown;
  chapters: unknown;
  chunks: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToRecord(row: RawPrecompiledMaterialRow): PrecompiledMaterialRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    originalName: row.original_name,
    mime: row.mime,
    sourceSha256: row.source_sha256,
    sourceBytes: Number(row.source_bytes),
    pageCount: Number(row.page_count),
    extractorVersion: row.extractor_version,
    text: row.text,
    pages: jsonArray<PrecompiledMaterialPage>(row.pages),
    chapters: jsonArray<PrecompiledMaterialChapter>(row.chapters),
    chunks: jsonArray<PrecompiledMaterialChunk>(row.chunks),
    status: row.status === 'failed' ? 'failed' : 'ready',
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

export function precompiledMaterialSummary(
  material: PrecompiledMaterialRecord,
): PrecompiledMaterialSummary {
  const { text, chapters, chunks, ...metadata } = material;
  delete (metadata as Partial<PrecompiledMaterialRecord>).pages;
  return {
    ...metadata,
    textChars: text.length,
    chunkCount: chunks.length,
    chapterCount: chapters.length,
  };
}

export async function listPrecompiledMaterialSummaries(
  queryable: Queryable,
): Promise<PrecompiledMaterialSummary[]> {
  const result = await queryable.query<RawPrecompiledMaterialRow>(
    `SELECT id, slug, title, original_name, mime, source_sha256, source_bytes,
            page_count, extractor_version, text, pages, chapters, chunks,
            status, created_at, updated_at
       FROM precompiled_material
      WHERE status = 'ready'
      ORDER BY updated_at DESC, id`,
  );
  return result.rows.map((row) => precompiledMaterialSummary(rowToRecord(row)));
}

export async function getPrecompiledMaterial(
  queryable: Queryable,
  slug: string,
): Promise<PrecompiledMaterialRecord | null> {
  const result = await queryable.query<RawPrecompiledMaterialRow>(
    `SELECT id, slug, title, original_name, mime, source_sha256, source_bytes,
            page_count, extractor_version, text, pages, chapters, chunks,
            status, created_at, updated_at
       FROM precompiled_material
      WHERE slug = $1 AND status = 'ready'
      LIMIT 1`,
    [slug],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}
