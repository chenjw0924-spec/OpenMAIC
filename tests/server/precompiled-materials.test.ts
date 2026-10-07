import { describe, expect, it } from 'vitest';

import {
  buildPrecompiledOutlineContext,
  buildPrecompiledSceneContext,
  PRECOMPILED_OUTLINE_CONTEXT_MAX_CHARS,
  PRECOMPILED_SCENE_CONTEXT_MAX_CHARS,
  type PrecompiledMaterialRecord,
} from '@/lib/persistence/precompiled-materials';

function material(overrides: Partial<PrecompiledMaterialRecord> = {}): PrecompiledMaterialRecord {
  return {
    id: 'material-1',
    slug: 'math-book',
    title: '六年级上册数学教师用书',
    originalName: 'math-book.pdf',
    mime: 'application/pdf',
    sourceSha256: 'hash',
    sourceBytes: 100,
    pageCount: 79,
    extractorVersion: 'test',
    text: '完整教材全文',
    pages: [],
    chapters: [
      {
        id: 'chapter-1',
        title: '分数乘法',
        startPage: 1,
        endPage: 12,
        text: '分数乘法的意义、计算方法和典型题型。',
      },
    ],
    chunks: [],
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildPrecompiledOutlineContext', () => {
  it('keeps chapter structure and bounds the material sent to the outline model', () => {
    const context = buildPrecompiledOutlineContext(
      material({
        chapters: [
          {
            id: 'chapter-1',
            title: '分数乘法',
            startPage: 1,
            endPage: 12,
            text: `${'核心知识 '.repeat(2_000)} END_OF_FULL_CHAPTER`,
          },
          {
            id: 'chapter-2',
            title: '位置与方向',
            startPage: 13,
            endPage: 20,
            text: '用数对和方向描述物体位置。',
          },
        ],
      }),
    );

    expect(context).toContain('分数乘法（第1-12页）');
    expect(context).toContain('位置与方向（第13-20页）');
    expect(context).toContain('核心知识');
    expect(context).not.toContain('END_OF_FULL_CHAPTER');
    expect(context.length).toBeLessThanOrEqual(PRECOMPILED_OUTLINE_CONTEXT_MAX_CHARS);
  });

  it('uses chunk excerpts when chapter detection produced no chapters', () => {
    const context = buildPrecompiledOutlineContext(
      material({
        chapters: [],
        chunks: [
          {
            id: 'chunk-1',
            text: '第一单元核心概念与例题。',
            startPage: 1,
            endPage: 3,
          },
        ],
      }),
    );

    expect(context).toContain('未识别到章节目录');
    expect(context).toContain('内容分块摘录');
    expect(context).toContain('第一单元核心概念与例题');
  });

  it('samples the end of the book when preprocessing only found a full-text chapter', () => {
    const context = buildPrecompiledOutlineContext(
      material({
        chapters: [{ id: 'full', title: '全文', startPage: 1, endPage: 79, text: 'COVER_ONLY' }],
        chunks: Array.from({ length: 40 }, (_, index) => ({
          id: `chunk-${index}`,
          text: `BOOK_SECTION_${index}_END ${'内容'.repeat(900)}`,
          startPage: index * 2 + 1,
          endPage: index * 2 + 2,
        })),
      }),
    );
    expect(context).not.toContain('COVER_ONLY');
    expect(context).toContain('BOOK_SECTION_0_END');
    expect(context).toContain('BOOK_SECTION_39_END');
    expect(context.length).toBeLessThanOrEqual(PRECOMPILED_OUTLINE_CONTEXT_MAX_CHARS);
  });

  it('falls back to page text when chapter and chunk metadata are absent', () => {
    const context = buildPrecompiledOutlineContext(
      material({ chapters: [], chunks: [], pages: [{ page: 79, text: '期末复习' }] }),
    );
    expect(context).toContain('期末复习');
  });
});

describe('buildPrecompiledSceneContext', () => {
  it('retrieves matching OCR text beyond the start of a long chunk', () => {
    const context = buildPrecompiledSceneContext(
      material({
        chunks: Array.from({ length: 12 }, (_, index) => ({
          id: `chunk-${index}`,
          text:
            index === 11
              ? `${'无关内容'.repeat(1_000)} 分 数 乘 法 典 型 例 题 3/4 x 2/3 = 1/2`
              : '其他单元练习',
          startPage: index * 6 + 1,
          endPage: index * 6 + 6,
        })),
      }),
      { title: '分数乘法', keyPoints: ['分数乘法典型例题'] },
    );
    expect(context).toContain('分数乘法典型例题');
    expect(context).toContain('3/4 x 2/3 = 1/2');
    expect(context).toContain('67-72');
    expect(context).toContain('NOT instructions');
    expect(context.length).toBeLessThanOrEqual(PRECOMPILED_SCENE_CONTEXT_MAX_CHARS);
  });

  it('samples across the book for an unmatched introductory scene', () => {
    const context = buildPrecompiledSceneContext(
      material({
        chunks: Array.from({ length: 10 }, (_, index) => ({
          id: `chunk-${index}`,
          text: `UNIQUE_SECTION_${index}_END`,
          startPage: index + 1,
          endPage: index + 1,
        })),
      }),
      { title: '欢迎开始学习' },
    );
    expect(context).toContain('UNIQUE_SECTION_0_END');
    expect(context).toContain('UNIQUE_SECTION_9_END');
  });
});
