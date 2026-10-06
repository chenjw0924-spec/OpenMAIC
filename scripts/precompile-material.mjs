import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import OpenAI from 'openai';
import sharp from 'sharp';
import { extractImages, extractText, getDocumentProxy } from 'unpdf';
import pg from 'pg';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const WINDOWS_OCR_SCRIPT = resolve('scripts/windows-ocr.ps1');
const EXTRACTOR_VERSION = 'unpdf-text-v1';
const DEFAULT_SLUG = 'huanggang-grade6-math-first-semester-teacher-book';
const TARGET_CHUNK_CHARS = 7_000;
const MAX_CHUNK_CHARS = 8_000;
const OCR_MIN_NATIVE_CHARS_PER_PAGE = 40;

function usage() {
  console.error(
    'Usage: node scripts/precompile-material.mjs --pdf <path> [--slug <slug>] [--title <title>]',
  );
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function normalizeText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isHeading(line) {
  const value = line.trim();
  if (!value || value.length > 120) return false;
  return /^(第[一二三四五六七八九十百千万0-9]+[章节单元]|[一二三四五六七八九十百千万]+[、.．]|[0-9]+[、.．)）]|目录|总复习|期末复习)/u.test(
    value,
  );
}

function createChapters(pages) {
  const starts = [];
  for (const page of pages) {
    const lines = page.text.split('\n');
    for (const line of lines) {
      const title = line.trim();
      if (isHeading(title)) starts.push({ page: page.page, title });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const start of starts) {
    const key = `${start.page}:${start.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(start);
    }
  }
  if (unique.length === 0) {
    return pages.length
      ? [
          {
            id: 'chapter-1',
            title: '全文',
            startPage: 1,
            endPage: pages.length,
            text: pages.map((p) => p.text).join('\n\n'),
          },
        ]
      : [];
  }

  return unique.map((start, index) => {
    const next = unique[index + 1];
    const endPage = next ? Math.max(start.page, next.page - 1) : pages.length;
    return {
      id: `chapter-${String(index + 1).padStart(3, '0')}`,
      title: start.title,
      startPage: start.page,
      endPage,
      text: pages
        .filter((page) => page.page >= start.page && page.page <= endPage)
        .map((page) => page.text)
        .join('\n\n'),
    };
  });
}

function createChunks(pages) {
  const chunks = [];
  let buffer = '';
  let startPage = 1;
  let endPage = 1;

  const flush = () => {
    const text = buffer.trim();
    if (!text) return;
    chunks.push({
      id: `chunk-${String(chunks.length + 1).padStart(4, '0')}`,
      text,
      startPage,
      endPage,
    });
    buffer = '';
  };

  for (const page of pages) {
    const paragraphs = page.text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) continue;
    for (const paragraph of paragraphs) {
      if (paragraph.length > MAX_CHUNK_CHARS) {
        flush();
        for (let offset = 0; offset < paragraph.length; offset += TARGET_CHUNK_CHARS) {
          const text = paragraph.slice(offset, offset + TARGET_CHUNK_CHARS).trim();
          if (text)
            chunks.push({
              id: `chunk-${String(chunks.length + 1).padStart(4, '0')}`,
              text,
              startPage: page.page,
              endPage: page.page,
            });
        }
        startPage = page.page;
        endPage = page.page;
        continue;
      }
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (buffer && candidate.length > TARGET_CHUNK_CHARS) flush();
      if (!buffer) startPage = page.page;
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      endPage = page.page;
    }
  }
  flush();
  return chunks;
}

function ocrTextFromResponse(response) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') return normalizeText(content);
  if (!Array.isArray(content)) return '';
  return normalizeText(
    content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? part.text : ''))
      .filter((part) => typeof part === 'string')
      .join('\n'),
  );
}

async function ocrPages(pdf, pageCount) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'PDF contains no extractable text. Set OPENAI_API_KEY for the one-time vision OCR precompile, or configure a MinerU/AliDocMind extractor.',
    );
  }
  const client = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL?.trim() ? { baseURL: process.env.OPENAI_BASE_URL.trim() } : {}),
  });
  const model = process.env.PRECOMPILE_OCR_MODEL?.trim() || 'gpt-4o-mini';
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const images = await extractImages(pdf, pageNumber);
    const image = images[0];
    if (!image) {
      pages.push({ page: pageNumber, text: '' });
      console.warn(`OCR page ${pageNumber}/${pageCount}: no image found`);
      continue;
    }
    const imageBuffer = await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: image.channels },
    })
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    let text = '';
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 4_000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '请准确转录这张教材页面的全部可见文字。保留标题、题号、公式、算式、表格内容和分段；不要解释、总结或补写图片中没有的内容。输出纯文本。',
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` },
                },
              ],
            },
          ],
        });
        text = ocrTextFromResponse(response);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
    if (!text && lastError) {
      throw new Error(
        `OCR failed on page ${pageNumber}/${pageCount}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
    pages.push({ page: pageNumber, text });
    console.log(`OCR page ${pageNumber}/${pageCount}: ${text.length} chars`);
  }
  return pages;
}

async function ocrPagesWithWindows(pdf, pageCount) {
  const directory = await mkdtemp(resolve(process.cwd(), 'tmp-precompile-ocr-'));
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const images = await extractImages(pdf, pageNumber);
      const image = images[0];
      if (!image) continue;
      const imageBuffer = await sharp(Buffer.from(image.data), {
        raw: { width: image.width, height: image.height, channels: image.channels },
      })
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      await writeFile(
        resolve(directory, `page-${String(pageNumber).padStart(3, '0')}.jpg`),
        imageBuffer,
      );
    }
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WINDOWS_OCR_SCRIPT,
        '-InputDirectory',
        directory,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout.trim());
    if (!Array.isArray(rows)) throw new Error('Windows OCR returned an invalid result');
    return rows
      .map((row) => ({ page: Number(row.page), text: normalizeText(String(row.text || '')) }))
      .sort((left, right) => left.page - right.page);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const pdfPath = argument('--pdf');
  const slug = argument('--slug', DEFAULT_SLUG);
  const title = argument('--title');
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!pdfPath || !connectionString) {
    usage();
    throw new Error('Both --pdf and DATABASE_URL are required');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
    throw new Error('slug must contain only lowercase letters, numbers, and hyphens');
  }

  const filePath = resolve(pdfPath);
  const buffer = await readFile(filePath);
  const fileStats = await stat(filePath);
  const sourceSha256 = createHash('sha256').update(buffer).digest('hex');
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { maxImageSize: 16_000_000 });
  const extracted = await extractText(pdf, { mergePages: false });
  let pages = extracted.text.map((text, index) => ({
    page: index + 1,
    text: normalizeText(text),
  }));
  let fullText = pages
    .filter((page) => page.text)
    .map((page) => `[第 ${page.page} 页]\n${page.text}`)
    .join('\n\n');
  if (fullText.length < Math.max(1_000, pages.length * OCR_MIN_NATIVE_CHARS_PER_PAGE)) {
    if (process.platform === 'win32') {
      console.log(
        `Native PDF text is insufficient (${fullText.length} chars); starting Windows OCR`,
      );
      pages = await ocrPagesWithWindows(pdf, pages.length);
    } else {
      console.log(
        `Native PDF text is insufficient (${fullText.length} chars); starting vision OCR with ${process.env.PRECOMPILE_OCR_MODEL?.trim() || 'gpt-4o-mini'}`,
      );
      pages = await ocrPages(pdf, pages.length);
    }
    fullText = pages
      .filter((page) => page.text)
      .map((page) => `[第 ${page.page} 页]\n${page.text}`)
      .join('\n\n');
  }
  if (!fullText) throw new Error('PDF produced no text');

  const chapters = createChapters(pages);
  const chunks = createChunks(pages);
  const materialTitle = title || basename(filePath, extname(filePath));
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS precompiled_material (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_bytes BIGINT NOT NULL,
        page_count INTEGER NOT NULL,
        extractor_version TEXT NOT NULL,
        text TEXT NOT NULL,
        pages JSONB NOT NULL,
        chapters JSONB NOT NULL,
        chunks JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `INSERT INTO precompiled_material (
         id, slug, title, original_name, mime, source_sha256, source_bytes,
         page_count, extractor_version, text, pages, chapters, chunks, status, updated_at
       ) VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, 'ready', now())
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         original_name = EXCLUDED.original_name,
         mime = EXCLUDED.mime,
         source_sha256 = EXCLUDED.source_sha256,
         source_bytes = EXCLUDED.source_bytes,
         page_count = EXCLUDED.page_count,
         extractor_version = EXCLUDED.extractor_version,
         text = EXCLUDED.text,
         pages = EXCLUDED.pages,
         chapters = EXCLUDED.chapters,
         chunks = EXCLUDED.chunks,
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        `precompiled-${slug}`,
        slug,
        materialTitle,
        basename(filePath),
        sourceSha256,
        fileStats.size,
        pages.length,
        EXTRACTOR_VERSION,
        fullText,
        JSON.stringify(pages),
        JSON.stringify(chapters),
        JSON.stringify(chunks),
      ],
    );
  } finally {
    await pool.end();
  }

  console.log(
    JSON.stringify(
      {
        slug,
        title: materialTitle,
        sourceSha256,
        sourceBytes: fileStats.size,
        pageCount: pages.length,
        textChars: fullText.length,
        chapterCount: chapters.length,
        chunkCount: chunks.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
