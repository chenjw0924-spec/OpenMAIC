import { after, type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

const log = createLogger('ClassroomJob API');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return withRequestOwner(req, async ({ ownerId }) => {
    let resolvedJobId: string | undefined;
    try {
      const { jobId } = await context.params;
      resolvedJobId = jobId;

      if (!isValidClassroomJobId(jobId)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
      }

      const job = await readClassroomGenerationJob(jobId);
      if (!job) {
        return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
      }
      if (job.ownerId && job.ownerId !== ownerId) {
        return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
      }

      // A Vercel instance can be reclaimed before `after()` gets to run. The
      // job input is persisted without browser-supplied provider credentials,
      // and the runner's atomic claim makes this recovery single-owner.
      if (job.status === 'queued' && job.input) {
        after(async () => {
          const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');
          await runClassroomGenerationJob(job.id, job.input!, buildRequestOrigin(req), job.ownerId);
        });
      }

      const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

      return apiSuccess({
        jobId: job.id,
        status: job.status,
        step: job.step,
        progress: job.progress,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
        scenesGenerated: job.scenesGenerated,
        totalScenes: job.totalScenes,
        result: job.result,
        error: job.error,
        done: job.status === 'succeeded' || job.status === 'failed',
      });
    } catch (error) {
      log.error(`Classroom job retrieval failed [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
      return apiError(
        'INTERNAL_ERROR',
        500,
        'Failed to retrieve classroom generation job',
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}
