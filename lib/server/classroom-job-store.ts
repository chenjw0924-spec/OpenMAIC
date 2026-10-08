import { promises as fs } from 'fs';
import path from 'path';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
  ClassroomGenerationCheckpoint,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  classroomStorageUsesDatabase,
  ensureClassroomJobsDir,
  getClassroomStoragePool,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  /** Safe-to-retry input. Per-user provider credentials are deliberately omitted. */
  input?: GenerateClassroomInput;
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
    ttsCoverage?: GenerateClassroomResult['ttsCoverage'];
    warning?: string;
  };
  error?: string;
  ownerId?: string;
  workflow?: {
    checkpoint: ClassroomGenerationCheckpoint;
  };
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

function buildResumableInput(input: GenerateClassroomInput): GenerateClassroomInput {
  const { webSearchApiKey: _webSearchApiKey, ...safeInput } = input;
  return safeInput;
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 5 * 60 * 1000; // one step is bounded below 4 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'queued',
      step: job.step === 'failed' ? 'queued' : job.step,
      message: 'Generation worker was reclaimed; resuming from the last checkpoint',
      error: undefined,
      completedAt: undefined,
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
    input: buildResumableInput(input),
    ...(ownerId ? { ownerId } : {}),
  };

  if (classroomStorageUsesDatabase()) {
    const pool = await getClassroomStoragePool();
    await pool.query(
      `INSERT INTO kestack_classroom_jobs (id, owner_id, data)
       VALUES ($1, $2, $3::jsonb)`,
      [jobId, ownerId ?? null, JSON.stringify(job)],
    );
    return job;
  }

  await ensureClassroomJobsDir();
  await writeJsonFileAtomic(jobFilePath(jobId), job);
  return job;
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  if (classroomStorageUsesDatabase()) {
    const pool = await getClassroomStoragePool();
    const result = await pool.query<{ data: ClassroomGenerationJob }>(
      'SELECT data FROM kestack_classroom_jobs WHERE id = $1',
      [jobId],
    );
    const job = result.rows[0]?.data;
    return job ? markStaleIfNeeded(job) : null;
  }
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as ClassroomGenerationJob;
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  if (classroomStorageUsesDatabase()) {
    const pool = await getClassroomStoragePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ data: ClassroomGenerationJob }>(
        'SELECT data FROM kestack_classroom_jobs WHERE id = $1 FOR UPDATE',
        [jobId],
      );
      const existing = result.rows[0]?.data;
      if (!existing) throw new Error(`Classroom generation job not found: ${jobId}`);
      const updated: ClassroomGenerationJob = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE kestack_classroom_jobs SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
        [jobId, JSON.stringify(updated)],
      );
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
): Promise<ClassroomGenerationJob> {
  const claimed = await claimClassroomGenerationJob(jobId);
  if (claimed) return claimed;

  const existing = await readClassroomGenerationJob(jobId);
  if (!existing) {
    throw new Error(`Classroom generation job not found: ${jobId}`);
  }
  return existing;
}

/**
 * Atomically claim a queued job for one process. This is the cross-instance
 * fence that makes polling-based recovery safe on Vercel.
 */
export async function claimClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  if (classroomStorageUsesDatabase()) {
    const pool = await getClassroomStoragePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ data: ClassroomGenerationJob }>(
        'SELECT data FROM kestack_classroom_jobs WHERE id = $1 FOR UPDATE',
        [jobId],
      );
      const existing = result.rows[0]?.data;
      const staleRunning =
        existing?.status === 'running' &&
        Date.now() - new Date(existing.updatedAt).getTime() > STALE_JOB_TIMEOUT_MS;
      if (!existing || (existing.status !== 'queued' && !staleRunning)) {
        await client.query('COMMIT');
        return null;
      }
      const updated: ClassroomGenerationJob = {
        ...existing,
        status: 'running',
        startedAt: existing.startedAt || new Date().toISOString(),
        message: 'Classroom generation started',
        updatedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE kestack_classroom_jobs SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
        [jobId, JSON.stringify(updated)],
      );
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    const staleRunning =
      existing?.status === 'running' &&
      Date.now() - new Date(existing.updatedAt).getTime() > STALE_JOB_TIMEOUT_MS;
    if (!existing || (existing.status !== 'queued' && !staleRunning)) return null;

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: progress.step,
    progress: progress.progress,
    message: progress.message,
    scenesGenerated: progress.scenesGenerated,
    totalScenes: progress.totalScenes,
  });
}

export async function queueClassroomGenerationCheckpoint(
  jobId: string,
  checkpoint: ClassroomGenerationCheckpoint,
): Promise<ClassroomGenerationJob> {
  const totalScenes = checkpoint.outlines.length;
  const sceneProgress =
    totalScenes > 0 ? 30 + Math.floor((checkpoint.nextSceneIndex / totalScenes) * 60) : 30;
  const progress =
    checkpoint.phase === 'media' ? 90 : checkpoint.phase === 'tts' ? 94 : sceneProgress;
  const step =
    checkpoint.phase === 'media'
      ? 'generating_media'
      : checkpoint.phase === 'tts'
        ? 'generating_tts'
        : 'generating_scenes';
  const message =
    checkpoint.phase === 'media'
      ? 'Scene generation complete; media generation queued'
      : checkpoint.phase === 'tts'
        ? 'Media generation complete; TTS generation queued'
        : `Generated ${checkpoint.scenes.length}/${totalScenes} scenes`;

  return updateClassroomGenerationJob(jobId, {
    status: 'queued',
    step,
    progress,
    message,
    scenesGenerated: checkpoint.scenes.length,
    totalScenes,
    workflow: { checkpoint },
    error: undefined,
    completedAt: undefined,
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: result.warning ?? 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
      ...(result.ttsCoverage ? { ttsCoverage: result.ttsCoverage } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}
