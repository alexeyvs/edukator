import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import { writeFileAtomic } from './atomic-write.js';
import { resolveCatalogPath } from './course-artifacts.js';
import { SystemOcrRunner, type OcrRunner } from './ocr-runner.js';
import { indexSourcePage } from './course-retrieval.js';

export const SUSPICIOUS_OCR_LENGTH = 20;

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface JobRow {
  id: number;
  course_id: string;
  revision_id: number;
  source_id: number;
  status: JobStatus;
  attempts: number;
}

interface SourceRow {
  id: number;
  course_id: string;
  revision_id: number;
  artifact_path: string;
  page_count: number;
}

export interface CatalogWorkerStatus {
  state: 'idle' | 'running' | 'stopping' | 'degraded';
  queued: number;
  running: number;
  failed: number;
  currentJobId: number | null;
  error: string | null;
}

export interface SourceProcessingStatus {
  sourceId: number;
  sourceStatus: string;
  job: { id: number; status: JobStatus; attempts: number; currentPage: number | null; error: string | null } | null;
  pages: Array<{ pageNumber: number; status: string; error: string | null }>;
}

export interface RetryRange {
  fromPage?: number;
  toPage?: number;
}

export interface CatalogWorkerOptions {
  runner?: OcrRunner;
  now?: () => Date;
  log?: (message: string) => void;
  autoPollMs?: number;
}

/** Persistent, single-concurrency OCR queue. Each page is its own checkpoint. */
export class CatalogWorker {
  private readonly runner: OcrRunner;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly autoPollMs: number;
  private processing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private started = false;
  private currentJobId: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    options: CatalogWorkerOptions = {},
  ) {
    this.runner = options.runner ?? new SystemOcrRunner({
      tempRoot: resolveCatalogPath(dataDir, 'catalog/tmp'),
    });
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.autoPollMs = options.autoPollMs ?? 1_000;
    this.recoverInterrupted();
  }

  enqueueSource(sourceId: number): number {
    const source = this.source(sourceId);
    const at = this.now().toISOString();
    const jobId = this.db.transaction(() => {
      for (let page = 1; page <= source.page_count; page += 1) {
        this.db.prepare(
          `INSERT INTO source_pages (source_id, page_number, status, updated_at)
           VALUES (?, ?, 'pending', ?)
           ON CONFLICT (source_id, page_number) DO NOTHING`,
        ).run(sourceId, page, at);
      }
      this.db.prepare(
        `INSERT INTO catalog_jobs
           (job_key, type, status, course_id, revision_id, source_id, created_at, updated_at)
         VALUES (?, 'ocr', 'queued', ?, ?, ?, ?, ?)
         ON CONFLICT (job_key) DO UPDATE SET
           status = CASE WHEN catalog_jobs.status = 'succeeded' THEN catalog_jobs.status ELSE 'queued' END,
           error = CASE WHEN catalog_jobs.status = 'succeeded' THEN catalog_jobs.error ELSE NULL END,
           updated_at = excluded.updated_at`,
      ).run(`ocr:${sourceId}`, source.course_id, source.revision_id, sourceId, at, at);
      this.db.prepare("UPDATE course_sources SET status = 'processing', error = NULL WHERE id = ?")
        .run(sourceId);
      return this.db.prepare<[string], { id: number }>('SELECT id FROM catalog_jobs WHERE job_key = ?')
        .get(`ocr:${sourceId}`)?.id;
    }).immediate();
    if (jobId === undefined) throw new Error('OCR job не найден после постановки в очередь');
    if (this.started) this.wake();
    return jobId;
  }

  retrySource(sourceId: number, range: RetryRange = {}): number {
    const source = this.source(sourceId);
    const from = range.fromPage ?? 1;
    const to = range.toPage ?? source.page_count;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > source.page_count) {
      throw new RangeError(`Диапазон OCR должен быть внутри 1..${source.page_count}`);
    }
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE source_pages SET status = 'pending', text = NULL, image_path = NULL,
             error = NULL, updated_at = ?
         WHERE source_id = ? AND page_number BETWEEN ? AND ?`,
      ).run(at, sourceId, from, to);
      this.db.prepare(
        `UPDATE catalog_jobs SET status = 'queued', current_page = ?, error = NULL, updated_at = ?
         WHERE job_key = ?`,
      ).run(from, at, `ocr:${sourceId}`);
      this.db.prepare("UPDATE course_sources SET status = 'processing', error = NULL WHERE id = ?")
        .run(sourceId);
    }).immediate();
    const job = this.db.prepare<[string], { id: number }>('SELECT id FROM catalog_jobs WHERE job_key = ?')
      .get(`ocr:${sourceId}`);
    if (job === undefined) return this.enqueueSource(sourceId);
    if (this.started) this.wake();
    return job.id;
  }

  sourceStatus(sourceId: number): SourceProcessingStatus {
    const source = this.db.prepare<[number], { id: number; status: string }>(
      'SELECT id, status FROM course_sources WHERE id = ?',
    ).get(sourceId);
    if (source === undefined) throw new Error('Источник не найден');
    const job = this.db.prepare<[number], {
      id: number; status: JobStatus; attempts: number; current_page: number | null; error: string | null;
    }>(
      'SELECT id, status, attempts, current_page, error FROM catalog_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1',
    ).get(sourceId);
    return {
      sourceId,
      sourceStatus: source.status,
      job: job === undefined ? null : {
        id: job.id, status: job.status, attempts: job.attempts, currentPage: job.current_page, error: job.error,
      },
      pages: this.db.prepare<[number], { page_number: number; status: string; error: string | null }>(
        'SELECT page_number, status, error FROM source_pages WHERE source_id = ? ORDER BY page_number',
      ).all(sourceId).map((page) => ({
        pageNumber: page.page_number, status: page.status, error: page.error,
      })),
    };
  }

  status(): CatalogWorkerStatus {
    const counts = this.db.prepare<[], { queued: number; running: number; failed: number }>(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM catalog_jobs WHERE type = 'ocr'`,
    ).get() ?? { queued: 0, running: 0, failed: 0 };
    return {
      state: this.stopping ? 'stopping' : this.currentJobId !== null ? 'running' :
        this.lastError === null && (counts.failed ?? 0) === 0 ? 'idle' : 'degraded',
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      failed: counts.failed ?? 0,
      currentJobId: this.currentJobId,
      error: this.lastError,
    };
  }

  start(): void {
    if (this.stopping || this.timer !== undefined) return;
    this.started = true;
    this.timer = setInterval(() => this.wake(), this.autoPollMs);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.stopping || this.processing !== undefined) return;
    this.processing = this.drain().finally(() => {
      this.processing = undefined;
    });
  }

  async drainNow(): Promise<void> {
    if (this.stopping) return;
    this.wake();
    await this.processing;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.runner.stop();
    await this.processing;
  }

  private recoverInterrupted(): void {
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE catalog_jobs SET status = 'queued', error = 'Перезапущено после остановки процесса', updated_at = ? WHERE status = 'running'",
      ).run(at);
      this.db.prepare(
        "UPDATE source_pages SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'processing'",
      ).run(at);
    }).immediate();
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const job = this.db.prepare<[], JobRow>(
        `SELECT id, course_id, revision_id, source_id, status, attempts
         FROM catalog_jobs WHERE type = 'ocr' AND status = 'queued' ORDER BY created_at, id LIMIT 1`,
      ).get();
      if (job === undefined) return;
      await this.process(job);
    }
  }

  private async process(job: JobRow): Promise<void> {
    this.currentJobId = job.id;
    const at = this.now().toISOString();
    this.db.prepare(
      "UPDATE catalog_jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?",
    ).run(at, job.id);
    try {
      await mkdir(resolveCatalogPath(this.dataDir, 'catalog/tmp'), { recursive: true });
      await this.runner.checkDependencies();
      const source = this.source(job.source_id);
      const pdfPath = resolveCatalogPath(this.dataDir, source.artifact_path);
      const pages = this.db.prepare<[number], { page_number: number }>(
        "SELECT page_number FROM source_pages WHERE source_id = ? AND status IN ('pending', 'failed') ORDER BY page_number",
      ).all(job.source_id);
      let failures = 0;
      for (const page of pages) {
        if (this.stopping) throw new Error('OCR worker остановлен');
        this.markPage(job.id, job.source_id, page.page_number, 'processing', null);
        try {
          const result = await this.runner.processPage({ pdfPath, pageNumber: page.page_number });
          const storedImage = `catalog/artifacts/${job.course_id}/${job.revision_id}/pages/${job.source_id}-${page.page_number}.jpg`;
          const imagePath = resolveCatalogPath(this.dataDir, storedImage);
          await mkdir(dirname(imagePath), { recursive: true });
          writeFileAtomic(imagePath, result.image);
          const text = result.text.trim();
          const pageStatus = text.length < SUSPICIOUS_OCR_LENGTH ? 'suspicious' : 'ready';
          this.db.prepare(
            `UPDATE source_pages SET status = ?, text = ?, image_path = ?, error = NULL, updated_at = ?
             WHERE source_id = ? AND page_number = ?`,
          ).run(pageStatus, text, storedImage, this.now().toISOString(), job.source_id, page.page_number);
          indexSourcePage(this.db, job.source_id, page.page_number, text);
        } catch (error) {
          failures += 1;
          this.markPage(job.id, job.source_id, page.page_number, 'failed', (error as Error).message);
          this.log(`OCR источника ${job.source_id}, страница ${page.page_number}: ${(error as Error).message}`);
        }
      }
      if (failures > 0) throw new Error(`Не распознано страниц: ${failures}`);
      this.db.transaction(() => {
        const doneAt = this.now().toISOString();
        this.db.prepare(
          "UPDATE catalog_jobs SET status = 'succeeded', current_page = NULL, error = NULL, updated_at = ? WHERE id = ?",
        ).run(doneAt, job.id);
        this.db.prepare("UPDATE course_sources SET status = 'ready', error = NULL WHERE id = ?").run(job.source_id);
      }).immediate();
      this.lastError = null;
    } catch (error) {
      const message = (error as Error).message;
      const status = this.stopping ? 'queued' : 'failed';
      this.db.transaction(() => {
        this.db.prepare(
          'UPDATE catalog_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?',
        ).run(status, message, this.now().toISOString(), job.id);
        this.db.prepare("UPDATE course_sources SET status = 'failed', error = ? WHERE id = ?")
          .run(message, job.source_id);
      }).immediate();
      this.lastError = message;
      this.log(`OCR job ${job.id}: ${message}`);
    } finally {
      this.currentJobId = null;
    }
  }

  private markPage(
    jobId: number,
    sourceId: number,
    page: number,
    status: 'processing' | 'failed',
    error: string | null,
  ): void {
    this.db.transaction(() => {
      const at = this.now().toISOString();
      this.db.prepare(
        'UPDATE source_pages SET status = ?, error = ?, updated_at = ? WHERE source_id = ? AND page_number = ?',
      ).run(status, error, at, sourceId, page);
      this.db.prepare('UPDATE catalog_jobs SET current_page = ?, updated_at = ? WHERE id = ?')
        .run(page, at, jobId);
    }).immediate();
  }

  private source(sourceId: number): SourceRow {
    const source = this.db.prepare<[number], SourceRow>(
      `SELECT id, course_id, revision_id, artifact_path, page_count
       FROM course_sources WHERE id = ?`,
    ).get(sourceId);
    if (source === undefined || source.page_count === null) throw new Error('Источник OCR не найден или не проверен');
    return source;
  }
}
