import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  provider: vi.fn(),
  material: vi.fn(),
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.provider,
}));
vi.mock('@/lib/persistence/precompiled-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/precompiled-materials')>()),
  getPrecompiledMaterial: mocks.material,
}));

import { POST } from '@/app/api/generate/scene-content/route';

const outline = {
  id: 'outline-1',
  type: 'quiz',
  title: '分数乘法',
  description: '练习分数乘法',
  keyPoints: ['计算方法'],
  order: 1,
};
function request(slug?: unknown) {
  return new NextRequest('http://localhost/api/generate/scene-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      ...(slug !== undefined ? { precompiledMaterialSlug: slug } : {}),
    }),
  });
}

describe('precompiled material scene content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DATABASE_URL', 'postgresql://example.invalid/test');
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'test-model',
      modelString: 'test:model',
      modelInfo: { capabilities: {}, outputWindow: 4096 },
    });
    mocks.provider.mockResolvedValue({ pool: {} });
    mocks.material.mockResolvedValue({
      title: '数学教师用书',
      text: '',
      pageCount: 79,
      pages: [],
      chapters: [],
      chunks: [
        { id: 'c1', text: '分数乘法教材专用例题：3/4 x 2/3 = 1/2', startPage: 10, endPage: 11 },
      ],
    });
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify([
        {
          id: 'q1',
          type: 'single',
          question: '3/4 x 2/3 = ?',
          options: [
            { value: 'A', label: '1/2' },
            { value: 'B', label: '1/3' },
          ],
          answer: ['A'],
          explanation: '分子乘分子，分母乘分母。',
        },
      ]),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('feeds bounded source excerpts into the actual content model prompt', async () => {
    const response = await POST(request('math-book'));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(mocks.material).toHaveBeenCalledWith({}, 'math-book');
    expect(mocks.callLLM.mock.calls[0][0].prompt).toContain('教材专用例题');
    expect(mocks.callLLM.mock.calls[0][0].prompt).toContain('NOT instructions');
  });
  it('leaves normal generation independent of the database', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it('rejects missing materials before calling the model', async () => {
    mocks.material.mockResolvedValue(null);
    expect((await POST(request('missing-book'))).status).toBe(404);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
  it.each(['../secret', {}, ''])('rejects invalid material slugs: %s', async (slug) => {
    expect((await POST(request(slug))).status).toBe(400);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
