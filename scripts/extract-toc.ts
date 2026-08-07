/**
 * Извлечение оглавления учебника в `content/raw-toc/<subject>.txt`.
 *
 * Порядок такой: сначала текстовый слой PDF (`pdf-parse`), а если его нет —
 * распознавание страниц системным Vision через `scripts/ocr-pdf.swift`. Все три
 * учебника оказались сканами, так что в реальности работает вторая ветка;
 * первая остаётся ради нормальных PDF и ради тестов.
 *
 * Запуск:
 *   npx tsx scripts/extract-toc.ts --subject math --pdf ~/Downloads/book.pdf
 *   npx tsx scripts/extract-toc.ts --subject math --pdf book.pdf --pages 333-334
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { SUBJECTS, type Subject } from '../server/db.js';
import { findTocPages, formatToc, type PdfPage, type TocSelection } from './toc.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Куда складываются извлечённые оглавления: вход для сборки карты тем. */
export const RAW_TOC_DIR = resolve(projectRoot, 'content', 'raw-toc');

const OCR_SCRIPT = resolve(projectRoot, 'scripts', 'ocr-pdf.swift');

/** Сколько страниц просматривается с каждого края книги, если диапазон не задан. */
const DEFAULT_SCAN_EDGE = 15;

/**
 * Ниже этого числа непробельных символов текстовый слой считается отсутствующим.
 * У скана на страницу приходится ноль символов, у настоящего PDF — сотни.
 */
const MIN_TEXT_LAYER_CHARS = 200;

export type Extraction = 'text' | 'ocr';

export interface ExtractTocOptions {
  pdfPath: string;
  subject: Subject;
  /** Явный диапазон страниц: отключает и просмотр краёв, и выбор по эвристике. */
  pages?: { from: number; to: number };
  /** Сколько страниц смотреть с начала и с конца книги. */
  scanEdge?: number;
  outDir?: string;
  /** `never` запрещает откат в OCR: нужен тестам и не-macOS. */
  ocr?: 'auto' | 'never';
}

export interface ExtractTocResult {
  outPath: string;
  selection: TocSelection;
  extraction: Extraction;
  /** Всего страниц в PDF. */
  total: number;
}

/** Проверяет, что файл вообще есть и это PDF, до всякого разбора. */
export function assertReadablePdf(pdfPath: string): void {
  let size: number;
  try {
    size = statSync(pdfPath).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`PDF не найден: ${pdfPath}`);
    throw new Error(`PDF ${pdfPath} не читается: ${(error as Error).message}`);
  }

  if (size === 0) throw new Error(`PDF ${pdfPath} пуст`);

  const signature = Buffer.alloc(5);
  const handle = openSync(pdfPath, 'r');
  try {
    readSync(handle, signature, 0, 5, 0);
  } finally {
    closeSync(handle);
  }

  if (signature.toString('latin1') !== '%PDF-') {
    throw new Error(`Файл ${pdfPath} не похож на PDF: нет сигнатуры %PDF в начале файла`);
  }
}

/** Номера страниц с обоих краёв книги: оглавление бывает и в начале, и в конце. */
export function scanWindow(total: number, edge: number = DEFAULT_SCAN_EDGE): number[] {
  const head = Array.from({ length: Math.min(edge, total) }, (_, index) => index + 1);
  const tail = Array.from({ length: Math.min(edge, total) }, (_, index) => total - index).reverse();
  return [...new Set([...head, ...tail])].sort((left, right) => left - right);
}

export function pageRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function nonSpaceChars(pages: PdfPage[]): number {
  return pages.reduce((sum, page) => sum + page.text.replace(/\s/gu, '').length, 0);
}

/** Читает текстовый слой указанных страниц (или всей книги, если страницы не заданы). */
export async function readPdfPages(
  pdfPath: string,
  pageNumbers?: number[],
): Promise<{ pages: PdfPage[]; total: number }> {
  const { readFile } = await import('node:fs/promises');
  const data = new Uint8Array(await readFile(pdfPath));
  const parser = new PDFParse({ data });
  try {
    // pageJoiner по умолчанию дописывает «-- 3 of 334 --», а это лишние строки
    // в знаменателе плотности.
    const result = await parser.getText({
      ...(pageNumbers === undefined ? {} : { partial: pageNumbers }),
      pageJoiner: '',
    });
    return {
      pages: result.pages.map((page) => ({ num: page.num, text: page.text })),
      total: result.total,
    };
  } catch (error) {
    throw new Error(`PDF ${pdfPath} не разбирается: ${(error as Error).message}`);
  } finally {
    await parser.destroy();
  }
}

/** Считает число страниц, не вытягивая текст: нужно, чтобы посчитать окно просмотра. */
export async function readPdfPageCount(pdfPath: string): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const data = new Uint8Array(await readFile(pdfPath));
  const parser = new PDFParse({ data });
  try {
    return (await parser.getInfo()).total;
  } catch (error) {
    throw new Error(`PDF ${pdfPath} не разбирается: ${(error as Error).message}`);
  } finally {
    await parser.destroy();
  }
}

/** Распознаёт страницы через `scripts/ocr-pdf.swift`. Одним вызовом на все страницы: swift компилирует скрипт при каждом запуске. */
export async function ocrPdfPages(pdfPath: string, pageNumbers: number[]): Promise<PdfPage[]> {
  const raw = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('swift', [OCR_SCRIPT, pdfPath, pageNumbers.join(',')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectPromise(
        error.code === 'ENOENT'
          ? new Error(
              'OCR недоступен: не найден swift. Распознавание сканов работает только на macOS ' +
                'с установленными Command Line Tools; на другой системе задайте PDF с текстовым слоем',
            )
          : error,
      );
    });

    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`OCR не удался (код ${code}): ${stderr.trim()}`));
    });
  });

  try {
    return JSON.parse(raw) as PdfPage[];
  } catch (error) {
    throw new Error(`OCR вернул неразбираемый ответ: ${(error as Error).message}`);
  }
}

/**
 * Достаёт оглавление и пишет его в `<outDir>/<subject>.txt`.
 * Возвращает выбранные страницы — по ним видно, что именно попало в файл.
 */
export async function extractToc(options: ExtractTocOptions): Promise<ExtractTocResult> {
  assertReadablePdf(options.pdfPath);

  const total = await readPdfPageCount(options.pdfPath);
  if (total === 0) throw new Error(`PDF ${options.pdfPath} не содержит страниц`);

  if (options.pages !== undefined) {
    const { from, to } = options.pages;
    if (from < 1 || to < from || to > total) {
      throw new Error(`Диапазон страниц ${from}-${to} выходит за пределы книги (1-${total})`);
    }
  }

  const wanted =
    options.pages === undefined
      ? scanWindow(total, options.scanEdge ?? DEFAULT_SCAN_EDGE)
      : pageRange(options.pages.from, options.pages.to);

  let pages = (await readPdfPages(options.pdfPath, wanted)).pages;
  let extraction: Extraction = 'text';

  if (nonSpaceChars(pages) < MIN_TEXT_LAYER_CHARS) {
    if (options.ocr === 'never') {
      throw new Error(
        `У ${options.pdfPath} нет текстового слоя (это скан), а распознавание отключено`,
      );
    }
    pages = await ocrPdfPages(options.pdfPath, wanted);
    extraction = 'ocr';
  }

  // Заданный вручную диапазон — прямое указание, эвристика в него не лезет.
  const selection: TocSelection =
    options.pages === undefined
      ? findTocPages(pages)
      : {
          pages,
          from: options.pages.from,
          to: options.pages.to,
          scores: [],
        };

  const outDir = options.outDir ?? RAW_TOC_DIR;
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${options.subject}.txt`);
  writeFileSync(outPath, formatToc(selection, { source: basename(options.pdfPath), extraction }));

  return { outPath, selection, extraction, total };
}

export interface CliArgs extends ExtractTocOptions {
  subject: Subject;
}

function parsePages(value: string): { from: number; to: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (match === null) throw new Error(`--pages ожидает «12» или «12-15», получено «${value}»`);
  const from = Number(match[1]);
  return { from, to: match[2] === undefined ? from : Number(match[2]) };
}

export function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  let ocr: 'auto' | 'never' = 'auto';

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--no-ocr') {
      ocr = 'never';
      continue;
    }
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    values.set(flag.slice(2), value);
    index += 1;
  }

  const subject = values.get('subject');
  if (subject === undefined || !SUBJECTS.includes(subject as Subject)) {
    throw new Error(`--subject обязателен и должен быть одним из: ${SUBJECTS.join(', ')}`);
  }
  const pdfPath = values.get('pdf');
  if (pdfPath === undefined) throw new Error('--pdf обязателен: путь к файлу учебника');

  const pages = values.get('pages');
  const scanEdge = values.get('scan');
  const outDir = values.get('out');

  return {
    subject: subject as Subject,
    pdfPath: resolve(pdfPath.replace(/^~(?=\/)/, process.env['HOME'] ?? '~')),
    ocr,
    ...(pages === undefined ? {} : { pages: parsePages(pages) }),
    ...(scanEdge === undefined ? {} : { scanEdge: Number(scanEdge) }),
    ...(outDir === undefined ? {} : { outDir: resolve(outDir) }),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await extractToc(options);
  const range =
    result.selection.from === result.selection.to
      ? `${result.selection.from}`
      : `${result.selection.from}-${result.selection.to}`;
  process.stdout.write(
    `${options.subject}: страницы ${range} из ${result.total} (${result.extraction}) → ${result.outPath}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`extract-toc: ${error.message}\n`);
    process.exitCode = 1;
  });
}
