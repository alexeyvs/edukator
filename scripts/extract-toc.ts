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
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { SUBJECTS, type Subject } from '../server/db.js';
import { findTocPages, formatToc, type PdfPage, type TocSelection } from './toc.js';
import { runChild } from '../server/run-child.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Куда складываются извлечённые оглавления: вход для сборки карты тем. */
export const RAW_TOC_DIR = resolve(projectRoot, 'content', 'raw-toc');

const OCR_SCRIPT = resolve(projectRoot, 'scripts', 'ocr-pdf.swift');

/** Сколько страниц просматривается с каждого края книги, если диапазон не задан. */
const DEFAULT_SCAN_EDGE = 15;

/**
 * Ниже этого числа непробельных символов на любой из запрошенных страниц
 * текстовый слой считается неполным. У скана на страницу приходится ноль
 * символов, у настоящего PDF — сотни. Проверять нужно каждую страницу: иначе
 * богатый слой соседних страниц скрывает скан оглавления в гибридном PDF.
 */
const MIN_TEXT_LAYER_CHARS_PER_PAGE = 200;
export const OCR_TIMEOUT_MS = 5 * 60 * 1000;

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
  /** Исполняемый файл для OCR; тесты подставляют заглушку вместо `swift`. */
  ocrBin?: string;
  ocrTimeoutMs?: number;
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

function hasUsableTextLayer(pages: PdfPage[]): boolean {
  return pages.every(
    (page) => page.text.replace(/\s/gu, '').length >= MIN_TEXT_LAYER_CHARS_PER_PAGE,
  );
}

/** Читает текстовый слой указанных страниц (или всей книги, если страницы не заданы). */
async function extractPdfPages(
  pdfPath: string,
  choosePages: (total: number) => number[] | undefined,
): Promise<{ pages: PdfPage[]; total: number }> {
  const { readFile } = await import('node:fs/promises');
  const data = new Uint8Array(await readFile(pdfPath));
  const parser = new PDFParse({ data });
  try {
    const total = (await parser.getInfo()).total;
    const pageNumbers = choosePages(total);
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

/** Читает текстовый слой указанных страниц (или всей книги). */
export function readPdfPages(
  pdfPath: string,
  pageNumbers?: number[],
): Promise<{ pages: PdfPage[]; total: number }> {
  return extractPdfPages(pdfPath, () => pageNumbers);
}

function isPdfPage(value: unknown): value is PdfPage {
  const page = value as PdfPage | null;
  return page !== null && typeof page === 'object'
    && typeof page.num === 'number' && typeof page.text === 'string';
}

/**
 * Распознаёт страницы через `scripts/ocr-pdf.swift`. Одним вызовом на все
 * страницы: swift компилирует скрипт при каждом запуске.
 *
 * `bin` подменяется тестами на заглушку — иначе ветка, которая в реальности и
 * работает (все три учебника — сканы), не проверялась бы вовсе.
 */
export async function ocrPdfPages(
  pdfPath: string,
  pageNumbers: number[],
  bin = 'swift',
  timeoutMs = OCR_TIMEOUT_MS,
): Promise<PdfPage[]> {
  let result;
  try {
    result = await runChild({
      bin,
      args: [OCR_SCRIPT, pdfPath, pageNumbers.join(',')],
      label: 'OCR',
      timeoutMs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'OCR недоступен: не найден swift. Распознавание сканов работает только на macOS ' +
          'с установленными Command Line Tools; на другой системе задайте PDF с текстовым слоем',
      );
    }
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(`OCR не удался (код ${result.code}): ${result.stderr.trim()}`);
  }
  const raw = result.stdout;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`OCR вернул неразбираемый ответ: ${(error as Error).message}`);
  }

  // Форма проверяется до разбора: `null` и `{}` — законный JSON, и приведение
  // типом их пропускает. Дальше сверка состава страниц падала бы на них голым
  // TypeError вместо внятной жалобы на распознавание.
  if (!Array.isArray(parsed) || !parsed.every(isPdfPage)) {
    throw new Error('OCR вернул ответ не в виде списка страниц');
  }
  const pages: PdfPage[] = parsed;

  // Состав страниц сверяется с запросом: у выпавшей страницы нет никакого следа
  // в ответе, а дальше по конвейеру неполное оглавление неотличимо от полного.
  const got = new Set(pages.map((page) => page.num));
  const missing = pageNumbers.filter((num) => !got.has(num));
  const duplicates = pages
    .map((page) => page.num)
    .filter((num, index, values) => values.indexOf(num) !== index);
  const requested = new Set(pageNumbers);
  const extra = pages.map((page) => page.num).filter((num) => !requested.has(num));
  const outOfOrder =
    pages.length === pageNumbers.length &&
    pages.some((page, index) => page.num !== pageNumbers[index]);
  if (missing.length > 0 || duplicates.length > 0 || extra.length > 0 || outOfOrder) {
    const details = [
      ...(missing.length === 0 ? [] : [`не вернул страницы: ${missing.join(', ')}`]),
      ...(duplicates.length === 0 ? [] : [`повторил страницы: ${[...new Set(duplicates)].join(', ')}`]),
      ...(extra.length === 0 ? [] : [`вернул лишние страницы: ${[...new Set(extra)].join(', ')}`]),
      ...(outOfOrder ? ['вернул страницы не в запрошенном порядке'] : []),
    ];
    throw new Error(`OCR ${details.join('; ')}`);
  }

  return pages;
}

/**
 * Достаёт оглавление и пишет его в `<outDir>/<subject>.txt`.
 * Возвращает выбранные страницы — по ним видно, что именно попало в файл.
 */
export async function extractToc(options: ExtractTocOptions): Promise<ExtractTocResult> {
  assertReadablePdf(options.pdfPath);

  const extracted = await extractPdfPages(options.pdfPath, (total) => {
    if (options.pages !== undefined) {
      const { from, to } = options.pages;
      if (from < 1 || to < from || to > total) {
        throw new Error(`Диапазон страниц ${from}-${to} выходит за пределы книги (1-${total})`);
      }
      return pageRange(from, to);
    }
    return scanWindow(total, options.scanEdge ?? DEFAULT_SCAN_EDGE);
  });
  const { total } = extracted;
  if (total === 0) throw new Error(`PDF ${options.pdfPath} не содержит страниц`);
  const wanted =
    options.pages === undefined
      ? scanWindow(total, options.scanEdge ?? DEFAULT_SCAN_EDGE)
      : pageRange(options.pages.from, options.pages.to);

  let pages = extracted.pages;
  let extraction: Extraction = 'text';
  let textSelection: TocSelection | undefined;
  if (options.pages === undefined) {
    try {
      textSelection = findTocPages(pages);
    } catch {
      // Если в текстовом слое оглавления нет, ниже решается, нужен ли OCR.
    }
  }

  const explicitText = options.pages !== undefined && pages.some((page) => page.text.trim() !== '');
  const trustExplicitText = explicitText && options.ocr === 'never';
  if (
    textSelection === undefined &&
    !trustExplicitText &&
    !hasUsableTextLayer(pages)
  ) {
    if (options.ocr === 'never') {
      throw new Error(
        `У ${options.pdfPath} нет текстового слоя (это скан), а распознавание отключено`,
      );
    }
    pages = await ocrPdfPages(options.pdfPath, wanted, options.ocrBin, options.ocrTimeoutMs);
    extraction = 'ocr';
  }

  // Заданный вручную диапазон — прямое указание, эвристика в него не лезет.
  const selection: TocSelection =
    options.pages === undefined
      ? (textSelection ?? findTocPages(pages))
      : {
          pages,
          from: options.pages.from,
          to: options.pages.to,
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
  const allowed = new Set(['subject', 'pdf', 'pages', 'scan', 'out']);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--no-ocr') {
      if (ocr === 'never') throw new Error('Флаг --no-ocr указан дважды');
      ocr = 'never';
      continue;
    }
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    values.set(name, value);
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

  // Без проверки `Number('abc')` даёт NaN, окно просмотра выходит пустым, и
  // скрипт «не находит оглавление» вместо жалобы на аргумент.
  if (scanEdge !== undefined && !/^[1-9]\d*$/.test(scanEdge)) {
    throw new Error(`--scan ожидает положительное число, получено «${scanEdge}»`);
  }

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
