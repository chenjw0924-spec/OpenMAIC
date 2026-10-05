import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export type MaterialByteInput = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface MaterialByteStore {
  put(key: string, body: MaterialByteInput, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

function nodeReadable(body: MaterialByteInput): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
  return Readable.from(body);
}

function safeLocalPath(root: string, key: string): string {
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`invalid material object key: ${key}`);
  }
  return path;
}

/** Local/self-hosted material byte storage, rooted under the runtime data directory. */
export class LocalMaterialByteStore implements MaterialByteStore {
  private readonly root: string;

  constructor(root: string = resolve(process.cwd(), 'data')) {
    this.root = resolve(root);
  }

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    const path = safeLocalPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(nodeReadable(body), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(safeLocalPath(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true });
  }
}

class PostgresMaterialByteStore implements MaterialByteStore {
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async put(key: string, body: MaterialByteInput, mime?: string): Promise<void> {
    const bytes = await materialInputToBuffer(body);
    const { pool } = await getServerPersistenceProvider(this.connectionString);
    await pool.query(
      `INSERT INTO kestack_material_bytes (object_key, mime, bytes)
       VALUES ($1, $2, $3)
       ON CONFLICT (object_key) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
      [key, mime ?? null, bytes],
    );
  }

  async get(key: string): Promise<Buffer> {
    const { pool } = await getServerPersistenceProvider(this.connectionString);
    const result = await pool.query<{ bytes: Buffer }>(
      'SELECT bytes FROM kestack_material_bytes WHERE object_key = $1',
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      const error = new Error(`Material bytes not found: ${key}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return Buffer.from(row.bytes);
  }

  async delete(key: string): Promise<void> {
    const { pool } = await getServerPersistenceProvider(this.connectionString);
    await pool.query('DELETE FROM kestack_material_bytes WHERE object_key = $1', [key]);
  }
}

async function materialInputToBuffer(body: MaterialByteInput): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of nodeReadable(body)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let sharedStore: MaterialByteStore | null = null;
let sharedStoreKey: string | undefined;
const TEST_STORE_KEY = '__test_store__';

export function getMaterialByteStore(): MaterialByteStore {
  if (sharedStore && sharedStoreKey === TEST_STORE_KEY) return sharedStore;
  const connectionString = process.env.DATABASE_URL?.trim() ?? '';
  if (sharedStore && sharedStoreKey === connectionString) return sharedStore;
  sharedStoreKey = connectionString;
  sharedStore = connectionString
    ? new PostgresMaterialByteStore(connectionString)
    : new LocalMaterialByteStore();
  return sharedStore;
}

export function setMaterialByteStoreForTests(store: MaterialByteStore | null): void {
  sharedStore = store;
  sharedStoreKey = store ? TEST_STORE_KEY : undefined;
}
