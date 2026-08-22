import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
export const DEFAULT_OCR_OUTPUT_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_OCR_IMAGE_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_OCR_IMAGE_MAX_DIMENSION = 2400;

export class OcrDependencyError extends Error {}
export class OcrTimeoutError extends Error {}
export class OcrOutputError extends Error {}
export class OcrStoppedError extends Error {}

export interface OcrPageRequest {
  pdfPath: string;
  pageNumber: number;
  signal?: AbortSignal;
}

export interface OcrPageResult {
  text: string;
  image: Buffer;
}

export interface OcrRunner {
  checkDependencies(signal?: AbortSignal): Promise<void>;
  processPage(request: OcrPageRequest): Promise<OcrPageResult>;
  stop(): Promise<void>;
}

export interface OcrBinaries {
  qpdf: string;
  ocrmypdf: string;
  pdftotext: string;
  pdftoppm: string;
  tesseract: string;
}

export interface OcrRunnerOptions {
  binaries?: Partial<OcrBinaries>;
  timeoutMs?: number;
  outputLimit?: number;
  imageLimit?: number;
  tempRoot?: string;
}

interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

const DEFAULT_BINARIES: OcrBinaries = {
  qpdf: 'qpdf',
  ocrmypdf: 'ocrmypdf',
  pdftotext: 'pdftotext',
  pdftoppm: 'pdftoppm',
  tesseract: 'tesseract',
};

/** Replaceable Linux OCR adapter. All external commands use argv, never a shell. */
export class SystemOcrRunner implements OcrRunner {
  private readonly binaries: OcrBinaries;
  private readonly timeoutMs: number;
  private readonly outputLimit: number;
  private readonly imageLimit: number;
  private readonly tempRoot: string;
  private readonly children = new Set<ChildProcess>();
  private stopping = false;

  constructor(options: OcrRunnerOptions = {}) {
    this.binaries = { ...DEFAULT_BINARIES, ...options.binaries };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
    this.outputLimit = options.outputLimit ?? DEFAULT_OCR_OUTPUT_LIMIT;
    this.imageLimit = options.imageLimit ?? DEFAULT_OCR_IMAGE_LIMIT;
    this.tempRoot = options.tempRoot ?? tmpdir();
  }

  async checkDependencies(signal?: AbortSignal): Promise<void> {
    if (this.stopping) throw new OcrStoppedError('OCR runner остановлен');
    const checks: Array<[string, readonly string[]]> = [
      [this.binaries.qpdf, ['--version']],
      [this.binaries.ocrmypdf, ['--version']],
      [this.binaries.pdftotext, ['-v']],
      [this.binaries.pdftoppm, ['-v']],
    ];
    for (const [binary, args] of checks) await this.command(binary, args, signal);
    const languages = await this.command(this.binaries.tesseract, ['--list-langs'], signal);
    const installed = new Set(languages.stdout.toString('utf8').split(/\s+/u));
    const missing = ['rus', 'eng'].filter((language) => !installed.has(language));
    if (missing.length > 0) {
      throw new OcrDependencyError(`Tesseract не содержит языки: ${missing.join(', ')}`);
    }
  }

  async processPage(request: OcrPageRequest): Promise<OcrPageResult> {
    if (this.stopping) throw new OcrStoppedError('OCR runner остановлен');
    if (!Number.isSafeInteger(request.pageNumber) || request.pageNumber < 1) {
      throw new OcrOutputError('Номер страницы OCR должен быть положительным целым числом');
    }
    const dir = await mkdtemp(join(this.tempRoot, 'edukator-ocr-'));
    const pagePdf = join(dir, 'page.pdf');
    const searchablePdf = join(dir, 'searchable.pdf');
    const imagePrefix = join(dir, 'page');
    try {
      await this.command(this.binaries.qpdf, [
        request.pdfPath, '--pages', request.pdfPath, String(request.pageNumber), '--', pagePdf,
      ], request.signal);
      await this.command(this.binaries.ocrmypdf, [
        '--force-ocr', '--deskew', '--rotate-pages', '--language', 'rus+eng',
        '--optimize', '1', pagePdf, searchablePdf,
      ], request.signal);
      const extracted = await this.command(
        this.binaries.pdftotext,
        ['-enc', 'UTF-8', searchablePdf, '-'],
        request.signal,
      );
      await this.command(this.binaries.pdftoppm, [
        '-f', '1', '-singlefile', '-jpeg', '-r', '144',
        '-scale-to', String(DEFAULT_OCR_IMAGE_MAX_DIMENSION),
        '-jpegopt', 'quality=78,optimize=y', searchablePdf, imagePrefix,
      ], request.signal);
      const imagePath = `${imagePrefix}.jpg`;
      let image: Buffer;
      try {
        const metadata = await stat(imagePath);
        if (metadata.size > this.imageLimit) {
          throw new OcrOutputError(
            `Poppler создал слишком большое изображение страницы: ${String(metadata.size)} байт`,
          );
        }
        image = await readFile(imagePath);
      } catch (error) {
        if (error instanceof OcrOutputError) throw error;
        throw new OcrOutputError('Poppler не создал изображение страницы');
      }
      if (image.length === 0) throw new OcrOutputError('Poppler создал пустое изображение страницы');
      return { text: extracted.stdout.toString('utf8').replaceAll('\u0000', '').trim(), image };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.children];
    for (const child of active) child.kill('SIGTERM');
    await Promise.all(active.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1_000);
      timer.unref();
    })));
  }

  private command(binary: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(this.commandError(binary, error));
        return;
      }
      this.children.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        if (error !== undefined) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      };
      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > this.outputLimit) {
          child.kill('SIGKILL');
          finish(new OcrOutputError(`Команда ${binary} превысила предел вывода ${this.outputLimit} байт`));
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on('data', collect(stdout));
      child.stderr?.on('data', collect(stderr));
      child.once('error', (error) => finish(this.commandError(binary, error)));
      child.once('exit', (code, exitSignal) => {
        if (settled) return;
        if (this.stopping) return finish(new OcrStoppedError(`Команда ${binary} остановлена`));
        if (code === 0) return finish();
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(new OcrOutputError(
          `${binary} завершился с ${code === null ? `сигналом ${String(exitSignal)}` : `кодом ${code}`}` +
          `${detail === '' ? '' : `: ${detail.slice(0, 1_000)}`}`,
        ));
      });
      const abort = (): void => {
        child.kill('SIGTERM');
        finish(new OcrStoppedError(`Команда ${binary} остановлена`));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new OcrTimeoutError(`Команда ${binary} превысила timeout ${this.timeoutMs} мс`));
      }, this.timeoutMs);
      timer.unref();
      if (signal?.aborted === true) abort();
    });
  }

  private commandError(binary: string, error: unknown): Error {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === 'ENOENT') return new OcrDependencyError(`OCR-зависимость ${binary} не установлена`);
    return new OcrOutputError(`Не удалось запустить ${binary}: ${cause.message ?? String(error)}`);
  }
}
