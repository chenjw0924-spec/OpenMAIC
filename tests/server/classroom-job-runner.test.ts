import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  claimClassroomGenerationJob: vi.fn(),
  markClassroomGenerationJobFailed: vi.fn(),
  markClassroomGenerationJobSucceeded: vi.fn(),
  queueClassroomGenerationCheckpoint: vi.fn(),
  updateClassroomGenerationJobProgress: vi.fn(),
}));

vi.mock('@/lib/server/classroom-generation', () => ({
  ClassroomGenerationCheckpointError: class ClassroomGenerationCheckpointError extends Error {
    checkpoint: unknown;

    constructor(checkpoint: unknown) {
      super('checkpoint');
      this.name = 'ClassroomGenerationCheckpointError';
      this.checkpoint = checkpoint;
    }
  },
  generateClassroom: mocks.generateClassroom,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  claimClassroomGenerationJob: mocks.claimClassroomGenerationJob,
  markClassroomGenerationJobFailed: mocks.markClassroomGenerationJobFailed,
  markClassroomGenerationJobSucceeded: mocks.markClassroomGenerationJobSucceeded,
  queueClassroomGenerationCheckpoint: mocks.queueClassroomGenerationCheckpoint,
  updateClassroomGenerationJobProgress: mocks.updateClassroomGenerationJobProgress,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('classroom job runner', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('persists a checkpoint and leaves the job queued after one bounded step', async () => {
    const checkpoint = { version: 1, phase: 'scene_content' };
    const { ClassroomGenerationCheckpointError } =
      await import('@/lib/server/classroom-generation');
    mocks.claimClassroomGenerationJob.mockResolvedValue({
      id: 'job-1',
      status: 'running',
      input: { requirement: 'A course' },
      ownerId: 'owner-1',
    });
    mocks.generateClassroom.mockRejectedValue(new ClassroomGenerationCheckpointError(checkpoint));

    const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');
    await runClassroomGenerationJob(
      'job-1',
      { requirement: 'A course' },
      'https://example.test',
      'owner-1',
    );

    expect(mocks.queueClassroomGenerationCheckpoint).toHaveBeenCalledWith('job-1', checkpoint);
    expect(mocks.markClassroomGenerationJobSucceeded).not.toHaveBeenCalled();
    expect(mocks.markClassroomGenerationJobFailed).not.toHaveBeenCalled();
  });

  it('marks an unrecoverable step failed so the retry endpoint can resume it', async () => {
    mocks.claimClassroomGenerationJob.mockResolvedValue({
      id: 'job-2',
      status: 'running',
      input: { requirement: 'A course' },
    });
    mocks.generateClassroom.mockRejectedValue(new Error('provider unavailable'));

    const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');
    await runClassroomGenerationJob('job-2', { requirement: 'A course' }, 'https://example.test');

    expect(mocks.markClassroomGenerationJobFailed).toHaveBeenCalledWith(
      'job-2',
      'provider unavailable',
    );
  });
});
