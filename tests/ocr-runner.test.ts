import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OcrDependencyError,
  OcrOutputError,
  OcrStoppedError,
  OcrTimeoutError,
  SystemOcrRunner,
} from '../server/ocr-runner.js';

describe('SystemOcrRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-ocr-runner-'));
    writeFileSync(join(dir, 'book.pdf'), '%PDF-1.4\nfixture');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function binary(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function workingBinaries() {
    return {
      qpdf: binary('qpdf', `
if [ "\${1:-}" = "--version" ]; then echo qpdf-1; exit 0; fi
for last do :; done
cp "$1" "$last"`),
      ocrmypdf: binary('ocrmypdf', `
if [ "\${1:-}" = "--version" ]; then echo ocrmypdf-1; exit 0; fi
prev=""; for item do prev2="$prev"; prev="$item"; done
cp "$prev2" "$prev"`),
      pdftotext: binary('pdftotext', `
if [ "\${1:-}" = "-v" ]; then exit 0; fi
printf 'Это русский текст учебной страницы для проверки OCR'`),
      pdftoppm: binary('pdftoppm', `
if [ "\${1:-}" = "-v" ]; then exit 0; fi
for last do :; done
printf 'jpeg-page' > "$last.jpg"`),
      tesseract: binary('tesseract', "printf 'List of available languages (2):\\nrus\\neng\\n'"),
    };
  }

  it('проверяет rus+eng и обрабатывает страницу безопасным argv pipeline', async () => {
    const runner = new SystemOcrRunner({ binaries: workingBinaries(), tempRoot: dir });
    await runner.checkDependencies();
    const page = await runner.processPage({ pdfPath: join(dir, 'book.pdf'), pageNumber: 2 });
    expect(page.text).toContain('русский текст');
    expect(page.image.toString()).toBe('jpeg-page');
  }, 15_000);

  it('понятно сообщает об отсутствующей зависимости и языке', async () => {
    const binaries = workingBinaries();
    const absent = new SystemOcrRunner({ binaries: { ...binaries, qpdf: join(dir, 'absent') } });
    await expect(absent.checkDependencies()).rejects.toThrow(OcrDependencyError);

    binaries.tesseract = binary('tesseract-no-rus', "printf 'eng\\n'");
    await expect(new SystemOcrRunner({ binaries }).checkDependencies()).rejects.toThrow(/rus/u);
  }, 15_000);

  it('ограничивает время и вывод дочерних процессов', async () => {
    const binaries = workingBinaries();
    binaries.qpdf = binary('slow-qpdf', 'sleep 2');
    await expect(new SystemOcrRunner({ binaries, timeoutMs: 20 }).checkDependencies())
      .rejects.toThrow(OcrTimeoutError);

    binaries.qpdf = binary('loud-qpdf', "printf '01234567890123456789'");
    await expect(new SystemOcrRunner({ binaries, outputLimit: 8 }).checkDependencies())
      .rejects.toThrow(OcrOutputError);
  }, 15_000);

  it('отвергает bad output Poppler', async () => {
    const binaries = workingBinaries();
    binaries.pdftoppm = binary('empty-pdftoppm', 'exit 0');
    const runner = new SystemOcrRunner({ binaries, tempRoot: dir });
    await expect(runner.processPage({ pdfPath: join(dir, 'book.pdf'), pageNumber: 1 }))
      .rejects.toThrow(/не создал изображение/u);
  }, 15_000);

  it('при shutdown завершает активный дочерний процесс', async () => {
    const binaries = workingBinaries();
    binaries.qpdf = binary('shutdown-qpdf', `
if [ "\${1:-}" = "--version" ]; then exit 0; fi
sleep 10`);
    const runner = new SystemOcrRunner({ binaries, tempRoot: dir, timeoutMs: 20_000 });
    const pending = runner.processPage({ pdfPath: join(dir, 'book.pdf'), pageNumber: 1 });
    const stopped = expect(pending).rejects.toThrow(OcrStoppedError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.stop();
    await stopped;
  });
});
