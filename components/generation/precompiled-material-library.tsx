'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Database, Loader2 } from 'lucide-react';
import type { PrecompiledMaterialSummary } from '@/lib/persistence/precompiled-materials';
import { cn } from '@/lib/utils';

interface PrecompiledMaterialLibraryProps {
  selectedSlug?: string | null;
  onSelect: (material: PrecompiledMaterialSummary) => void;
}

export function PrecompiledMaterialLibrary({
  selectedSlug,
  onSelect,
}: PrecompiledMaterialLibraryProps) {
  const [materials, setMaterials] = useState<PrecompiledMaterialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/precompiled-materials', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Could not load precompiled materials');
        return response.json() as Promise<{ materials?: PrecompiledMaterialSummary[] }>;
      })
      .then((data) => {
        if (!active) return;
        setMaterials(Array.isArray(data.materials) ? data.materials : []);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  if (!loading && !error && materials.length === 0) return null;

  return (
    <section
      className="relative z-10 mt-12 w-full max-w-6xl"
      aria-labelledby="precompiled-material-library-title"
    >
      <div className="mb-4 flex items-end justify-between gap-4 px-1">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BookOpen className="size-4 text-violet-600 dark:text-violet-400" />
            <h2 id="precompiled-material-library-title">预编译教材库</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground/70">
            已完成文字识别与结构化处理，选中后可直接生成课程。
          </p>
        </div>
        {materials.length > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
            {materials.length} 份教材
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/50 px-4 py-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在加载教材库
        </div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
          教材库暂时无法加载，请稍后刷新重试。
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {materials.map((material) => {
            const selected = selectedSlug === material.slug;
            return (
              <article
                key={material.slug}
                className={cn(
                  'rounded-xl border bg-background/70 p-4 transition-colors',
                  selected
                    ? 'border-violet-400/70 bg-violet-50/60 shadow-sm dark:border-violet-600/70 dark:bg-violet-950/20'
                    : 'border-border/60 hover:border-violet-300/70 dark:hover:border-violet-700/70',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                    <BookOpen className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
                      {material.title}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
                      <span>{material.pageCount} 页</span>
                      <span>{material.chapterCount} 个章节</span>
                      <span>{material.chunkCount} 个内容块</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-3">
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                    <Database className="size-3" />
                    已完成预处理
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelect(material)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                      selected
                        ? 'bg-violet-600 text-white hover:bg-violet-700'
                        : 'bg-foreground text-background hover:opacity-85',
                    )}
                  >
                    {selected ? (
                      <Check className="size-3.5" />
                    ) : (
                      <ArrowRight className="size-3.5" />
                    )}
                    {selected ? '已选中' : '基于此教材生成课程'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
