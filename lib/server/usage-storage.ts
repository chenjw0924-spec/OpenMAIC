import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { hasBillableTokens, type NormalizedUsage } from '@/lib/usage/normalize';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const log = createLogger('UsageStorage');

/** Base directory for usage logs; lands in the openmaic-data volume in Docker. */
function usageDir(baseDir?: string): string {
  return baseDir ?? path.join(process.cwd(), 'data', 'usage');
}

/** Current month's jsonl file name, e.g. usage/2026-06.jsonl. */
function monthlyFile(dir: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(dir, `${y}-${m}.jsonl`);
}

/** What kind of generation produced this usage. */
export type UsageKind = 'llm' | 'image' | 'video' | 'tts' | 'asr';
/** Unit of the non-token quantity. */
export type UsageUnit = 'token' | 'image' | 'second' | 'character';

/** Input to record one generation's usage. */
export interface UsageRecordInput {
  /** Modality. Defaults to 'llm'. */
  kind?: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  /** Token usage (LLM only). */
  usage?: NormalizedUsage;
  /** Non-token quantity: images count / seconds / characters. */
  quantity?: number;
  /** Unit for `quantity`. */
  unit?: UsageUnit;
}

/** A persisted usage row — pure usage, no cost. */
export interface UsageRecord {
  id: string;
  createdAt: number;
  kind: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  // LLM token counts (0 for non-LLM rows).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  // Non-token usage (e.g. image count, video seconds, TTS characters).
  quantity?: number;
  unit?: UsageUnit;
}

interface RecordOptions {
  baseDir?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

let counter = 0;
function makeId(now: Date): string {
  counter = (counter + 1) % 1_000_000;
  return `${now.getTime()}-${counter.toString(36)}`;
}

const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

let databaseSchemaPromise: Promise<void> | undefined;

async function getUsagePool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  const provider = await getServerPersistenceProvider(connectionString);
  databaseSchemaPromise ??= provider.pool
    .query(
      `
      CREATE TABLE IF NOT EXISTS kestack_usage_records (
        id TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_string TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cache_read_tokens BIGINT NOT NULL DEFAULT 0,
        cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
        reasoning_tokens BIGINT NOT NULL DEFAULT 0,
        quantity DOUBLE PRECISION,
        unit TEXT
      )
    `,
    )
    .then(() => undefined)
    .catch((error) => {
      databaseSchemaPromise = undefined;
      throw error;
    });
  await databaseSchemaPromise;
  return provider.pool;
}

/**
 * Records one generation's usage as a jsonl line. Fire-and-forget: never throws —
 * a logging failure must not break generation.
 *
 * - LLM rows: require billable tokens (skips empty usage, e.g. a streamed
 *   OpenAI-compatible response that omitted usage).
 * - Non-LLM rows (image/video/tts/asr): require quantity > 0.
 */
export async function recordUsage(
  input: UsageRecordInput,
  opts: RecordOptions = {},
): Promise<void> {
  // A test run must never append to the app's real usage log. Any test that
  // exercises callLLM / streamLLM reaches this through `recordUsageSafe` without
  // asking for it, and used to write rows into the live `data/usage/` file —
  // `minimax-auth-test`, `serialization-test` and friends were sitting in there
  // next to production traffic, corrupting any real usage analysis. Tests that
  // mean to exercise storage pass an explicit `baseDir` (or mock this module),
  // so both of those keep working.
  if (!opts.baseDir && (process.env.VITEST || process.env.NODE_ENV === 'test')) return;

  try {
    const kind: UsageKind = input.kind ?? 'llm';
    const usage = input.usage ?? ZERO_USAGE;

    if (kind === 'llm') {
      if (!hasBillableTokens(usage)) return;
    } else if (!input.quantity || input.quantity <= 0) {
      return;
    }

    const now = opts.now ?? new Date();
    const record: UsageRecord = {
      id: makeId(now),
      createdAt: now.getTime(),
      kind,
      source: input.source,
      providerId: input.providerId,
      modelId: input.modelId,
      modelString: input.modelString,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      reasoningTokens: usage.reasoningTokens,
      ...(input.quantity != null ? { quantity: input.quantity } : {}),
      ...(input.unit ? { unit: input.unit } : {}),
    };

    if (!opts.baseDir) {
      const pool = await getUsagePool();
      if (pool) {
        await pool.query(
          `INSERT INTO kestack_usage_records
             (id, created_at, kind, source, provider_id, model_id, model_string,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              reasoning_tokens, quantity, unit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            record.id,
            record.createdAt,
            record.kind,
            record.source,
            record.providerId,
            record.modelId,
            record.modelString,
            record.inputTokens,
            record.outputTokens,
            record.cacheReadTokens,
            record.cacheCreationTokens,
            record.reasoningTokens,
            record.quantity ?? null,
            record.unit ?? null,
          ],
        );
        return;
      }
    }
    const dir = usageDir(opts.baseDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(monthlyFile(dir, now), JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.warn('Failed to record usage (ignored):', err);
  }
}

/** A non-LLM modality usage event (image / video / tts / asr). */
export interface GenerationUsageInput {
  kind: Exclude<UsageKind, 'llm'>;
  unit: UsageUnit;
  providerId: string;
  /** The client-requested model id; falls back to providerId when absent. */
  modelId?: string;
  quantity: number;
}

/**
 * Records a non-LLM generation's usage. Thin wrapper over {@link recordUsage}
 * that derives `source` (= kind) and `modelString` (`provider:model`) from the
 * modality, so the generate routes don't each repeat that construction.
 * Fire-and-forget like `recordUsage`.
 */
export function recordGenerationUsage(input: GenerationUsageInput): Promise<void> {
  const modelId = input.modelId || input.providerId;
  return recordUsage({
    kind: input.kind,
    unit: input.unit,
    source: input.kind,
    providerId: input.providerId,
    modelId,
    modelString: `${input.providerId}:${modelId}`,
    quantity: input.quantity,
  });
}

interface ReadOptions {
  baseDir?: string;
  /** Limit to specific YYYY-MM month files; defaults to all files in the dir. */
  months?: string[];
}

/**
 * Reads all usage records (across monthly files). Returns [] when the dir is
 * absent. Malformed lines are skipped. Legacy rows without `kind` are treated as
 * 'llm'; any legacy cost fields are simply ignored.
 */
export async function readUsageRecords(opts: ReadOptions = {}): Promise<UsageRecord[]> {
  if (!opts.baseDir) {
    const pool = await getUsagePool();
    if (pool) {
      const params: unknown[] = [];
      let where = '';
      if (opts.months?.length) {
        params.push(opts.months.map((month) => `${month}%`));
        where = `WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS month_pattern
                           WHERE to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM') LIKE month_pattern)`;
      }
      const result = await pool.query<{
        id: string;
        created_at: string;
        kind: UsageKind;
        source: string;
        provider_id: string;
        model_id: string;
        model_string: string;
        input_tokens: string;
        output_tokens: string;
        cache_read_tokens: string;
        cache_creation_tokens: string;
        reasoning_tokens: string;
        quantity: number | null;
        unit: UsageUnit | null;
      }>(
        `SELECT id, created_at, kind, source, provider_id, model_id, model_string,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                reasoning_tokens,
                quantity, unit
           FROM kestack_usage_records ${where} ORDER BY created_at, id`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: Number(row.created_at),
        kind: row.kind,
        source: row.source,
        providerId: row.provider_id,
        modelId: row.model_id,
        modelString: row.model_string,
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheCreationTokens: Number(row.cache_creation_tokens),
        reasoningTokens: Number(row.reasoning_tokens),
        ...(row.quantity === null ? {} : { quantity: Number(row.quantity) }),
        ...(row.unit === null ? {} : { unit: row.unit }),
      }));
    }
  }
  const dir = usageDir(opts.baseDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  if (opts.months?.length) {
    files = files.filter((f) => opts.months!.some((m) => f.startsWith(m)));
  }

  const records: UsageRecord[] = [];
  for (const file of files.sort()) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as UsageRecord;
        if (!row.kind) row.kind = 'llm'; // backward-compat
        records.push(row);
      } catch {
        // skip malformed line
      }
    }
  }
  return records;
}
