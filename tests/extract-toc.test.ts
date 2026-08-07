import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertReadablePdf,
  extractToc,
  pageRange,
  parseArgs,
  readPdfPages,
  scanWindow,
} from '../scripts/extract-toc.js';

/**
 * Собирает крошечный PDF с текстовым слоем: страница — массив строк.
 * Тестам нужен настоящий PDF, а не заглушка, иначе не проверить связку
 * `pdf-parse` → эвристика → файл. Только ASCII: базовый Helvetica без
 * встроенных шрифтов кириллицу не покажет.
 */
function buildPdf(pages: string[][]): Buffer {
  const escape = (line: string): string => line.replace(/([\\()])/g, '\\$1');
  const streams = pages.map((lines) =>
    ['BT', '/F1 12 Tf', '16 TL', '40 780 Td', ...lines.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join(
      '\n',
    ),
  );

  const count = pages.length;
  const firstPageObj = 3;
  const firstStreamObj = firstPageObj + count;
  const fontObj = firstStreamObj + count;

  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${firstPageObj + index} 0 R`).join(' ')}] /Count ${count} >>`,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${firstStreamObj + index} 0 R >>`,
    ),
    ...streams.map(
      (stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const PROSE = [
  'The quick brown fox jumps over the lazy dog again and again,',
  'and the sentence keeps going so that the page carries enough',
  'characters to look like a real text layer rather than a scan.',
  'Nothing here resembles a table of contents entry at all,',
  'because none of these lines ends with a page number.',
  'The paragraph simply continues for a few more lines,',
  'so the density of contents-like lines stays at zero.',
];

const CONTENTS = [
  'Contents',
  'Unit 1 Getting to know you .......... 5',
  'Unit 2 Family album ................. 18',
  'Unit 3 School life .................. 32',
  'Unit 4 Free time .................... 47',
  'Unit 5 Around the world ............. 61',
  'Unit 6 Healthy living ............... 78',
];

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-toc-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('assertReadablePdf', () => {
  it('пропускает настоящий PDF', () => {
    const path = join(dir, 'ok.pdf');
    writeFileSync(path, buildPdf([PROSE]));
    expect(() => assertReadablePdf(path)).not.toThrow();
  });

  it('сообщает об отсутствующем файле, а не падает стеком', () => {
    expect(() => assertReadablePdf(join(dir, 'ghost.pdf'))).toThrow(/не найден/);
  });

  it('сообщает, что файл не PDF', () => {
    const path = join(dir, 'not-a.pdf');
    writeFileSync(path, 'это просто текст, а не PDF');
    expect(() => assertReadablePdf(path)).toThrow(/не похож на PDF/);
  });

  it('сообщает о пустом файле', () => {
    const path = join(dir, 'empty.pdf');
    writeFileSync(path, '');
    expect(() => assertReadablePdf(path)).toThrow(/пуст/);
  });
});

describe('scanWindow', () => {
  it('берёт страницы с обоих краёв книги', () => {
    expect(scanWindow(100, 3)).toEqual([1, 2, 3, 98, 99, 100]);
  });

  it('не задваивает страницы, если книга короче двух окон', () => {
    expect(scanWindow(4, 3)).toEqual([1, 2, 3, 4]);
  });

  it('не выходит за пределы одностраничной книги', () => {
    expect(scanWindow(1, 15)).toEqual([1]);
  });
});

describe('pageRange', () => {
  it('разворачивает диапазон в номера страниц', () => {
    expect(pageRange(3, 5)).toEqual([3, 4, 5]);
  });
});

describe('readPdfPages', () => {
  it('читает текстовый слой запрошенных страниц', async () => {
    const path = join(dir, 'two-pages.pdf');
    writeFileSync(path, buildPdf([PROSE, CONTENTS]));
    const { pages, total } = await readPdfPages(path, [2]);
    expect(total).toBe(2);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain('Family album');
  });
});

describe('extractToc', () => {
  it('находит оглавление и пишет его в файл предмета', async () => {
    const path = join(dir, 'book.pdf');
    writeFileSync(path, buildPdf([PROSE, CONTENTS, PROSE]));

    const result = await extractToc({ pdfPath: path, subject: 'english', outDir: dir, ocr: 'never' });

    expect(result.extraction).toBe('text');
    expect(result.selection.from).toBe(2);
    expect(result.outPath).toBe(join(dir, 'english.txt'));
    const written = readFileSync(result.outPath, 'utf8');
    expect(written).toContain('# источник: book.pdf');
    expect(written).toContain('Unit 2 Family album');
    expect(written).not.toContain('quick brown fox');
  });

  it('берёт заданный вручную диапазон, не спрашивая эвристику', async () => {
    const path = join(dir, 'manual.pdf');
    writeFileSync(path, buildPdf([PROSE, CONTENTS]));

    const result = await extractToc({
      pdfPath: path,
      subject: 'math',
      outDir: dir,
      pages: { from: 1, to: 1 },
      ocr: 'never',
    });

    expect(result.selection.from).toBe(1);
    expect(readFileSync(result.outPath, 'utf8')).toContain('quick brown fox');
  });

  it('отвергает диапазон за пределами книги', async () => {
    const path = join(dir, 'short.pdf');
    writeFileSync(path, buildPdf([PROSE]));
    await expect(
      extractToc({ pdfPath: path, subject: 'math', outDir: dir, pages: { from: 4, to: 9 } }),
    ).rejects.toThrow(/выходит за пределы книги/);
  });

  it('сообщает, что оглавление не найдено, и советует задать страницы', async () => {
    const path = join(dir, 'prose-only.pdf');
    writeFileSync(path, buildPdf([PROSE, PROSE]));
    await expect(
      extractToc({ pdfPath: path, subject: 'russian', outDir: dir, ocr: 'never' }),
    ).rejects.toThrow(/Оглавление не найдено.*--pages/s);
  });

  it('сообщает о скане, когда текстового слоя нет, а OCR запрещён', async () => {
    const path = join(dir, 'scan.pdf');
    writeFileSync(path, buildPdf([['x']]));
    await expect(
      extractToc({ pdfPath: path, subject: 'math', outDir: dir, ocr: 'never' }),
    ).rejects.toThrow(/нет текстового слоя/);
  });

  it('не трогает несуществующий файл дальше проверки', async () => {
    await expect(
      extractToc({ pdfPath: join(dir, 'nope.pdf'), subject: 'math', outDir: dir }),
    ).rejects.toThrow(/не найден/);
  });
});

describe('parseArgs', () => {
  it('разбирает предмет, путь и диапазон страниц', () => {
    const args = parseArgs(['--subject', 'math', '--pdf', 'book.pdf', '--pages', '12-15']);
    expect(args.subject).toBe('math');
    expect(args.pdfPath.endsWith('book.pdf')).toBe(true);
    expect(args.pages).toEqual({ from: 12, to: 15 });
  });

  it('понимает одну страницу в --pages', () => {
    expect(parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--pages', '7']).pages).toEqual({
      from: 7,
      to: 7,
    });
  });

  it('понимает --no-ocr', () => {
    expect(parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--no-ocr']).ocr).toBe('never');
  });

  it('отвергает неизвестный предмет', () => {
    expect(() => parseArgs(['--subject', 'physics', '--pdf', 'b.pdf'])).toThrow(/--subject/);
  });

  it('требует --pdf', () => {
    expect(() => parseArgs(['--subject', 'math'])).toThrow(/--pdf/);
  });

  it('отвергает битый --pages', () => {
    expect(() => parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--pages', 'весь'])).toThrow(
      /--pages/,
    );
  });

  it('отвергает флаг без значения', () => {
    expect(() => parseArgs(['--subject'])).toThrow(/нет значения/);
  });
});
