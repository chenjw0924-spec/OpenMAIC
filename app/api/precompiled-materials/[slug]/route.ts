import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getPrecompiledMaterial } from '@/lib/persistence/precompiled-materials';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const { slug } = await context.params;
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid precompiled material slug');
  }

  try {
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const material = await getPrecompiledMaterial(pool, slug);
    if (!material) return apiError('INVALID_REQUEST', 404, 'Precompiled material not found');
    return NextResponse.json({ success: true, material });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Could not load precompiled material',
    );
  }
}
