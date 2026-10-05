import { describe, expect, it } from 'vitest';

import { parseStudyPackGeneration } from '@/app/api/study-pack/route';

describe('study-pack generation protocol', () => {
  it('normalizes fenced JSON and alternates invalid speakers', () => {
    const result = parseStudyPackGeneration(
      `
        \`\`\`json
        {
          "title": "细胞结构",
          "summary": "基础复习",
          "flashcards": [
            {"question":"细胞膜的作用是什么？","answer":"控制物质进出细胞。","source":"控制物质进出"},
            {"question":"细胞核的作用是什么？","answer":"储存遗传信息并调控细胞活动。"},
            {"question":"线粒体的主要作用是什么？","answer":"为细胞活动提供能量。"},
            {"question":"核糖体负责什么？","answer":"合成蛋白质。"}
          ],
          "dialogue": [
            {"speaker":"host","text":"先从细胞膜开始。"},
            {"speaker":"unknown","text":"它像一道选择性屏障。"},
            {"speaker":"host","text":"细胞核保存什么信息？"},
            {"speaker":"guest","text":"遗传信息。"},
            {"speaker":"host","text":"线粒体有什么作用？"},
            {"speaker":"guest","text":"提供能量。"},
            {"speaker":"host","text":"核糖体负责什么？"},
            {"speaker":"guest","text":"合成蛋白质。"}
          ]
        }
        \`\`\`
      `,
      8,
      12,
    );

    expect(result.title).toBe('细胞结构');
    expect(result.flashcards).toHaveLength(4);
    expect(result.dialogue).toHaveLength(8);
    expect(result.dialogue[1]?.speaker).toBe('guest');
    expect(result.flashcards[0]?.source).toBe('控制物质进出');
  });

  it('rejects an incomplete model response', () => {
    expect(() =>
      parseStudyPackGeneration(JSON.stringify({ flashcards: [], dialogue: [] }), 8, 12),
    ).toThrow('too few study-pack items');
  });
});
