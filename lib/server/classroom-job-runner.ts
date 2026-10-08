import { createLogger } from '@/lib/logger';
import { LLM_REQUEST_TIMEOUT_MS } from '@/lib/ai/llm';
import {
  ClassroomGenerationCheckpointError,
  generateClassroom,
  type GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import {
  claimClassroomGenerationJob,
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobSucceeded,
  queueClassroomGenerationCheckpoint,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
  ownerId?: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      const claimed = await claimClassroomGenerationJob(jobId);
      if (!claimed) return;

      const result = await generateClassroom(input, {
        baseUrl,
        ownerId,
        signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
        resume: claimed.workflow?.checkpoint,
        checkpointAfterInitialization: !claimed.workflow?.checkpoint,
        checkpointAfterEachScene: true,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      if (error instanceof ClassroomGenerationCheckpointError) {
        await queueClassroomGenerationCheckpoint(jobId, error.checkpoint);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
