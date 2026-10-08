import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ClassroomGenerationJob } from '@/lib/server/classroom-job-store';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createJob: vi.fn(),
  readJob: vi.fn(),
  updateJob: vi.fn(),
  runJob: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createJob,
  readClassroomGenerationJob: mocks.readJob,
  updateClassroomGenerationJob: mocks.updateJob,
  isValidClassroomJobId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runJob,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function request(path: string, cookie?: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toMatch(/^anonymous_id=[a-f0-9-]+;/);
  expect(cookie).toContain('HttpOnly');
  return cookie!.split(';')[0];
}

describe('classroom job identity across requests', () => {
  let job: ClassroomGenerationJob | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_SINGLE_USER', '');
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    job = undefined;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createJob.mockImplementation(async (id, input, ownerId) => {
      const now = new Date().toISOString();
      job = {
        id,
        input,
        ownerId,
        status: 'queued',
        step: 'queued',
        progress: 0,
        message: 'queued',
        createdAt: now,
        updatedAt: now,
        inputSummary: {
          requirementPreview: input.requirement,
          hasPdf: false,
          pdfTextLength: 0,
          pdfImageCount: 0,
        },
        scenesGenerated: 0,
      };
      return job;
    });
    mocks.readJob.mockImplementation(async (id) => (job?.id === id ? job : null));
    mocks.updateJob.mockImplementation(async (_id, patch) => {
      job = { ...job!, ...patch };
      return job;
    });
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    vi.unstubAllEnvs();
  });

  async function create(cookie?: string, body = { requirement: 'One-page test course' }) {
    const { POST } = await import('@/app/api/generate-classroom/route');
    return POST(request('/api/generate-classroom', cookie, body));
  }

  async function poll(cookie?: string) {
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    return GET(request(`/api/generate-classroom/${job!.id}`, cookie), {
      params: Promise.resolve({ jobId: job!.id }),
    });
  }

  async function retry(cookie?: string) {
    const { POST } = await import('@/app/api/generate-classroom/[jobId]/route');
    return POST(request(`/api/generate-classroom/${job!.id}`, cookie, {}), {
      params: Promise.resolve({ jobId: job!.id }),
    });
  }

  it('sets the first owner cookie so subsequent polling can find the job', async () => {
    const created = await create();
    expect(created.status).toBe(202);
    const cookie = cookieFrom(created);
    expect(created.headers.get('cache-control')).toBe('private, no-store');

    const polled = await poll(cookie);
    expect(polled.status).toBe(200);
    expect(cookieFrom(polled)).toBe(cookie);
    expect(polled.headers.get('cache-control')).toBe('private, no-store');
    await expect(polled.json()).resolves.toMatchObject({ jobId: job!.id, status: 'queued' });
    expect(mocks.after).toHaveBeenCalledTimes(2);
  });

  it('keeps other anonymous sessions from reading or retrying the job', async () => {
    const cookie = cookieFrom(await create());
    const foreignPoll = await poll();
    expect(foreignPoll.status).toBe(404);
    expect(cookieFrom(foreignPoll)).not.toBe(cookie);
    const foreignRetry = await retry();
    expect(foreignRetry.status).toBe(404);
    expect(mocks.updateJob).not.toHaveBeenCalled();
  });

  it('renews the same owner cookie when a failed job is retried', async () => {
    const cookie = cookieFrom(await create());
    job!.status = 'failed';
    job!.error = 'Upstream timeout';
    const response = await retry(cookie);
    expect(response.status).toBe(202);
    expect(cookieFrom(response)).toBe(cookie);
    await expect(response.json()).resolves.toMatchObject({ status: 'queued' });
    expect(job!.error).toBeUndefined();
  });

  it('keeps the owner cookie on validation errors and successful resubmission', async () => {
    const rejected = await create(undefined, { requirement: '' });
    expect(rejected.status).toBe(400);
    const cookie = cookieFrom(rejected);
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(cookieFrom(await create(cookie))).toBe(cookie);
    expect((await poll(cookie)).status).toBe(200);
  });

  it('keeps the owner cookie on storage failures', async () => {
    mocks.createJob.mockRejectedValueOnce(new Error('Database unavailable'));
    const response = await create();
    expect(response.status).toBe(500);
    cookieFrom(response);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps the owner cookie when retry is refused or polling fails', async () => {
    const cookie = cookieFrom(await create());
    const refused = await retry(cookie);
    expect(refused.status).toBe(409);
    expect(cookieFrom(refused)).toBe(cookie);
    mocks.readJob.mockRejectedValueOnce(new Error('Database unavailable'));
    const failed = await poll(cookie);
    expect(failed.status).toBe(500);
    expect(cookieFrom(failed)).toBe(cookie);
  });
});
