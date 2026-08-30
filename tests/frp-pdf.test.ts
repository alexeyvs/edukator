import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cutPdf, readPdfPages } from '../scripts/frp-pdf.js';

let dir: string;

function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'frp-pdf-')); });

describe('readPdfPages', () => {
  it('разбивает вывод pdftotext по переводу страницы', async () => {
    const pdftotext = stub('pdftotext', 'printf "первая\\014 вторая"');
    const pages = await readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' });
    expect(pages).toEqual([{ num: 1, text: 'первая' }, { num: 2, text: ' вторая' }]);
  });

  it('отказ pdftotext доносится, а не глотается', async () => {
    const pdftotext = stub('pdftotext', 'echo "сломался" >&2; exit 3');
    await expect(readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' }))
      .rejects.toThrow(/pdftotext/u);
  });

  it('пустой документ даёт пустой список страниц, а не одну пустую', async () => {
    const pdftotext = stub('pdftotext', 'printf ""');
    expect(await readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' })).toEqual([]);
  });

  it('не добавляет фантомную страницу из-за завершающего перевода pdftotext', async () => {
    // Настоящий pdftotext (poppler) дописывает перевод страницы и после
    // последней страницы, а не только между страницами: документ из двух
    // страниц даёт "первая\f вторая\f", а не "первая\f вторая". Наивное
    // разбиение по \f даёт на один кусок больше, чем страниц, и последний —
    // пустой.
    const pdftotext = stub('pdftotext', 'printf "первая\\014 вторая\\014"');
    const pages = await readPdfPages(join(dir, 'x.pdf'), { pdftotext, qpdf: 'qpdf' });
    expect(pages).toEqual([{ num: 1, text: 'первая' }, { num: 2, text: ' вторая' }]);
  });
});

describe('cutPdf', () => {
  it('передаёт qpdf по одному диапазону страниц на отрезок', async () => {
    const log = join(dir, 'argv.txt');
    const qpdf = stub('qpdf', `printf '%s\\n' "$@" > ${log}`);
    const input = join(dir, 'in.pdf');
    const output = join(dir, 'out.pdf');
    await cutPdf(input, output, [{ from: 2, to: 3 }, { from: 9, to: 9 }],
      { pdftotext: 'pdftotext', qpdf });
    const argv = readFileSync(log, 'utf8').trim().split('\n');
    // Утверждение держит всю последовательность, а не отдельные подстроки:
    // проверка «есть --empty» и «где-то есть 2-3» прошла бы и без --pages,
    // и без повторения входного файла на каждый диапазон.
    expect(argv).toEqual([
      '--empty', '--pages',
      input, '2-3',
      input, '9-9',
      '--', output,
    ]);
  });

  it('пустой список диапазонов — отказ, а не пустой PDF', async () => {
    await expect(cutPdf(join(dir, 'in.pdf'), join(dir, 'out.pdf'), []))
      .rejects.toThrow(/диапазон/u);
  });

  it('отказ qpdf доносится с кодом возврата', async () => {
    const qpdf = stub('qpdf', 'echo "битый PDF" >&2; exit 2');
    await expect(cutPdf(join(dir, 'in.pdf'), join(dir, 'out.pdf'), [{ from: 1, to: 1 }],
      { pdftotext: 'pdftotext', qpdf })).rejects.toThrow(/qpdf/u);
  });
});
