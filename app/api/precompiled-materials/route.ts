import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { listPrecompiledMaterialSummaries } from '@/lib/persistence/precompiled-materials';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

/** Public catalog of server-precompiled materials; source text stays on the detail route. */
export async function GET() {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  try {
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const materials = await listPrecompiledMaterialSummaries(pool);
    return NextResponse.json({ success: true, materials });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Could not load precompiled materials',
    );
  }
}
