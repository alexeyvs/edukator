import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertReadablePdf,
  extractToc,
  ocrPdfPages,
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
const projectRoot = resolve('.');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const extractCli = join(projectRoot, 'scripts', 'extract-toc.ts');

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

  it('не отправляет в OCR редкое, но найденное текстовое оглавление', async () => {
    const path = join(dir, 'sparse-toc.pdf');
    writeFileSync(path, buildPdf([CONTENTS, ...Array.from({ length: 14 }, () => [''])]));
    const result = await extractToc({ pdfPath: path, subject: 'english', outDir: dir, ocr: 'never' });
    expect(result.extraction).toBe('text');
    expect(result.selection.from).toBe(1);
  });

  it('распознаёт скан оглавления рядом с богатым текстовым слоем', async () => {
    const path = join(dir, 'hybrid-auto.pdf');
    const richText = Array.from({ length: 12 }, () =>
      'This ordinary paragraph has enough characters to mask a scanned neighbouring page.',
    );
    writeFileSync(path, buildPdf([richText, ['Page 2']]));
    const bin = join(dir, 'hybrid-auto-ocr.sh');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `printf '%s' '${JSON.stringify([
          { num: 1, text: richText.join('\n') },
          {
            num: 2,
            text: [
              'Contents',
              'Unit 1 Hello .......... 5',
              'Unit 2 Family ......... 18',
              'Unit 3 School ......... 32',
            ].join('\n'),
          },
        ])}'`,
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    const result = await extractToc({
      pdfPath: path,
      subject: 'english',
      outDir: dir,
      ocrBin: bin,
    });

    expect(result.extraction).toBe('ocr');
    expect(result.selection.from).toBe(2);
    expect(readFileSync(result.outPath, 'utf8')).toContain('Unit 3 School');
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

  it('не принимает короткий ручной диапазон с текстом за скан', async () => {
    const path = join(dir, 'manual-sparse.pdf');
    writeFileSync(path, buildPdf([['Unit 1']]));

    const result = await extractToc({
      pdfPath: path,
      subject: 'english',
      outDir: dir,
      pages: { from: 1, to: 1 },
      ocr: 'never',
    });

    expect(result.extraction).toBe('text');
    expect(readFileSync(result.outPath, 'utf8')).toContain('Unit 1');
  });

  it('распознаёт ручной диапазон со штампом вместо молчаливого неполного результата', async () => {
    const path = join(dir, 'manual-stamped-scan.pdf');
    writeFileSync(path, buildPdf([['Page 12'], ['']]));
    const bin = join(dir, 'manual-range-ocr.sh');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        "printf '%s' '[{\"num\":1,\"text\":\"Contents\\nUnit 1 Hello .......... 5\"},{\"num\":2,\"text\":\"Unit 2 Family ......... 18\"}]'",
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    const result = await extractToc({
      pdfPath: path,
      subject: 'english',
      outDir: dir,
      pages: { from: 1, to: 2 },
      ocrBin: bin,
    });

    expect(result.extraction).toBe('ocr');
    expect(readFileSync(result.outPath, 'utf8')).toContain('Unit 2 Family');
  });

  it('распознаёт пустую страницу ручного диапазона рядом с богатым текстовым слоем', async () => {
    const path = join(dir, 'manual-hybrid.pdf');
    const richText = Array.from({ length: 12 }, () =>
      'This ordinary paragraph has enough characters to mask a scanned neighbouring page.',
    );
    writeFileSync(path, buildPdf([richText, ['Page 2']]));
    const bin = join(dir, 'manual-hybrid-ocr.sh');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `printf '%s' '${JSON.stringify([
          { num: 1, text: richText.join('\n') },
          { num: 2, text: 'Unit 2 Family ......... 18' },
        ])}'`,
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    const result = await extractToc({
      pdfPath: path,
      subject: 'english',
      outDir: dir,
      pages: { from: 1, to: 2 },
      ocrBin: bin,
    });

    expect(result.extraction).toBe('ocr');
    expect(readFileSync(result.outPath, 'utf8')).toContain('Unit 2 Family');
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

  it('считает сканом книгу, где на страницу приходятся единицы символов', async () => {
    // У скана текстового слоя нет, но штампованный колонтитул на каждой
    // странице есть. По сумме окна просмотра такая книга легко перебирает
    // порог и уходит мимо распознавания — считать надо на страницу.
    const path = join(dir, 'stamped-scan.pdf');
    const stamped = Array.from({ length: 12 }, (_, index) => [
      `Merzlyak Mathematics grade 6 workbook page ${index + 1}`,
    ]);
    writeFileSync(path, buildPdf(stamped));

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

describe('ocrPdfPages', () => {
  /**
   * Исполняемая заглушка вместо swift: в реальности работает именно эта ветка
   * (все три учебника — сканы), а настоящий Vision в тестах не запустить.
   */
  function fakeOcrBin(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('передаёт страницы одним вызовом и разбирает ответ', async () => {
    const bin = fakeOcrBin(
      'ocr-ok.sh',
      // $1 — путь к swift-скрипту, $2 — PDF, $3 — список страниц.
      `printf '[{"num":3,"text":"страницы %s"},{"num":4,"text":""},{"num":5,"text":""}]' "$3"`,
    );

    const pages = await ocrPdfPages('/tmp/book.pdf', [3, 4, 5], bin);

    expect(pages).toEqual([
      { num: 3, text: 'страницы 3,4,5' },
      { num: 4, text: '' },
      { num: 5, text: '' },
    ]);
  });

  it('сообщает о недостающих страницах, а не отдаёт укороченный ответ', async () => {
    // Vision может не отрисовать отдельную страницу. Молча выпавшая середина
    // оглавления выглядит ровно как полное оглавление — и уходит в карту тем.
    const bin = fakeOcrBin('ocr-partial.sh', `printf '[{"num":3,"text":"а"},{"num":5,"text":"б"}]'`);

    await expect(ocrPdfPages('/tmp/book.pdf', [3, 4, 5], bin)).rejects.toThrow(
      /не вернул страницы: 4/,
    );
  });

  it('отвергает повторённые и лишние страницы', async () => {
    const duplicate = fakeOcrBin(
      'ocr-duplicate.sh',
      `printf '[{"num":3,"text":"а"},{"num":3,"text":"б"},{"num":4,"text":"в"}]'`,
    );
    await expect(ocrPdfPages('/tmp/book.pdf', [3, 4], duplicate)).rejects.toThrow(/повторил страницы: 3/);

    const extra = fakeOcrBin(
      'ocr-extra.sh',
      `printf '[{"num":3,"text":"а"},{"num":4,"text":"б"},{"num":99,"text":"в"}]'`,
    );
    await expect(ocrPdfPages('/tmp/book.pdf', [3, 4], extra)).rejects.toThrow(/лишние страницы: 99/);

    const reordered = fakeOcrBin(
      'ocr-reordered.sh',
      `printf '[{"num":4,"text":"б"},{"num":3,"text":"а"}]'`,
    );
    await expect(ocrPdfPages('/tmp/book.pdf', [3, 4], reordered)).rejects.toThrow(
      /не в запрошенном порядке/,
    );
  });

  it('сообщает о неразбираемом ответе распознавания', async () => {
    const bin = fakeOcrBin('ocr-junk.sh', `printf 'не json'`);

    await expect(ocrPdfPages('/tmp/book.pdf', [1], bin)).rejects.toThrow(/неразбираемый ответ/);
  });

  it('отвергает разбираемый ответ не той формы', async () => {
    // `null` и `{}` — законный JSON, разбор их пропускает. Без проверки формы
    // проверка состава страниц падала на них голым TypeError.
    for (const [name, body] of [
      ['ocr-null.sh', 'null'],
      ['ocr-object.sh', '{}'],
      ['ocr-shape.sh', '[{"num":"3"}]'],
    ]) {
      const bin = fakeOcrBin(name ?? '', `printf '${body ?? ''}'`);

      await expect(ocrPdfPages('/tmp/book.pdf', [3], bin)).rejects.toThrow(
        /не в виде списка страниц/,
      );
    }
  });

  it('поднимает код возврата и stderr распознавания', async () => {
    const bin = fakeOcrBin('ocr-fail.sh', 'echo "страница не рендерится" >&2\nexit 3');

    await expect(ocrPdfPages('/tmp/book.pdf', [1], bin)).rejects.toThrow(
      /OCR не удался \(код 3\).*страница не рендерится/s,
    );
  });

  it('объясняет отсутствие swift, а не отдаёт голый ENOENT', async () => {
    await expect(ocrPdfPages('/tmp/book.pdf', [1], join(dir, 'нет-такого-swift'))).rejects.toThrow(
      /OCR недоступен.*macOS/s,
    );
  });

  it('останавливает зависший OCR по сроку', async () => {
    const bin = fakeOcrBin('ocr-hang.sh', "trap '' TERM\nwhile :; do sleep 1; done");
    await expect(ocrPdfPages('/tmp/book.pdf', [1], bin, 30)).rejects.toThrow(/превышен срок/);
  });

  it('подхватывается extractToc, когда текстового слоя нет', async () => {
    const path = join(dir, 'scan-ocr.pdf');
    writeFileSync(path, buildPdf([['x']]));
    // Кавычки у метки heredoc отключают подстановки: `\n` доходит до JSON.parse
    // как escape-последовательность, а не как настоящий перевод строки.
    const bin = fakeOcrBin(
      'ocr-toc.sh',
      [
        "cat <<'JSON'",
        '[{"num":1,"text":"Contents\\nUnit 1 Hello .......... 5\\nUnit 2 Family ......... 18\\nUnit 3 School ......... 32"}]',
        'JSON',
      ].join('\n'),
    );

    const result = await extractToc({
      pdfPath: path,
      subject: 'english',
      outDir: dir,
      ocrBin: bin,
    });

    expect(result.extraction).toBe('ocr');
    expect(readFileSync(result.outPath, 'utf8')).toContain('Unit 2 Family');
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

  it('разбирает --scan', () => {
    expect(parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--scan', '25']).scanEdge).toBe(25);
  });

  it('отвергает битый --scan, а не считает окно от NaN', () => {
    // Number('весь') даёт NaN, окно просмотра выходит пустым, и скрипт
    // жаловался бы на ненайденное оглавление вместо битого аргумента.
    for (const broken of ['весь', '0', '-5', '3.5']) {
      expect(() => parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--scan', broken]), broken)
        .toThrow(/--scan/);
    }
  });

  it('отвергает флаг без значения', () => {
    expect(() => parseArgs(['--subject'])).toThrow(/нет значения/);
  });

  // `$&` в строке-замене — ссылка на совпадение, то есть на сам «~».
  it('подставляет HOME буквально, даже когда в нём есть $', () => {
    const home = process.env['HOME'];
    process.env['HOME'] = '/tmp/$&dom';
    try {
      expect(parseArgs(['--subject', 'math', '--pdf', '~/book.pdf']).pdfPath)
        .toBe('/tmp/$&dom/book.pdf');
    } finally {
      if (home === undefined) delete process.env['HOME'];
      else process.env['HOME'] = home;
    }
  });

  it('отвергает неизвестный и повторный флаг', () => {
    expect(() => parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--ouut', 'x']))
      .toThrow(/Неизвестный флаг/);
    expect(() => parseArgs(['--subject', 'math', '--pdf', 'b.pdf', '--pdf', 'c.pdf']))
      .toThrow(/дважды/);
  });
});

describe('extract-toc CLI', () => {
  it('возвращает код 1 и диагностику при ошибочных аргументах', () => {
    const result = spawnSync(process.execPath, [tsxCli, extractCli, '--subject', 'math'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/extract-toc:.*--pdf/s);
  });

  it('извлекает заданную страницу через настоящий CLI-вход', () => {
    const pdfPath = join(dir, 'cli-book.pdf');
    const outDir = join(dir, 'cli-out');
    writeFileSync(pdfPath, buildPdf([CONTENTS]));

    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        extractCli,
        '--subject',
        'english',
        '--pdf',
        pdfPath,
        '--pages',
        '1',
        '--no-ocr',
        '--out',
        outDir,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/english: страницы 1 из 1 \(text\).*english\.txt/s);
    expect(readFileSync(join(outDir, 'english.txt'), 'utf8')).toContain('Unit 1 Getting to know you');
  });
});
