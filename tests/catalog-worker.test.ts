import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogWorker } from '../server/catalog-worker.js';
import { createCourse } from '../server/course-catalog.js';
import { openControlDatabase } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import type { OcrPageRequest, OcrPageResult, OcrRunner } from '../server/ocr-runner.js';

class FakeRunner implements OcrRunner {
  fail = new Set<number>();
  stopped = false;
  calls: number[] = [];

  async checkDependencies(): Promise<void> {}
  async processPage(request: OcrPageRequest): Promise<OcrPageResult> {
    this.calls.push(request.pageNumber);
    if (this.fail.has(request.pageNumber)) throw new Error(`сломана страница ${request.pageNumber}`);
    return {
      text: request.pageNumber === 3 ? 'мало' : `Распознанный русский текст страницы номер ${request.pageNumber}`,
      image: Buffer.from(`image-${request.pageNumber}`),
    };
  }
  async stop(): Promise<void> { this.stopped = true; }
}

describe('CatalogWorker', () => {
  let dir: string;
  let db: Database;
  let sourceId: number;
  let runner: FakeRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-catalog-worker-'));
    ensureDataDir(dir);
    db = openControlDatabase(controlDatabasePath(dir));
    const draft = createCourse(db, { id: 'geography-5', title: 'География', grade: '5 класс' }).draft;
    const artifactPath = `catalog/artifacts/geography-5/${draft.id}/book.pdf`;
    const full = join(dir, artifactPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '%PDF-1.4\nfixture');
    sourceId = Number(db.prepare(
      `INSERT INTO course_sources
         (course_id, revision_id, upload_name, sha256, artifact_path, page_count, status)
       VALUES ('geography-5', ?, 'book.pdf', ?, ?, 3, 'uploaded')`,
    ).run(draft.id, 'a'.repeat(64), artifactPath).lastInsertRowid);
    runner = new FakeRunner();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('обрабатывает только один persistent job и сохраняет page checkpoints атомарно', async () => {
    const worker = new CatalogWorker(db, dir, { runner });
    const jobId = worker.enqueueSource(sourceId);
    await worker.drainNow();

    expect(runner.calls).toEqual([1, 2, 3]);
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'ready',
      job: { id: jobId, status: 'succeeded', attempts: 1 },
      pages: [
        { pageNumber: 1, status: 'ready' },
        { pageNumber: 2, status: 'ready' },
        { pageNumber: 3, status: 'suspicious' },
      ],
    });
    expect(db.prepare<[number], { image_path: string; text: string }>(
      'SELECT image_path, text FROM source_pages WHERE source_id = ? AND page_number = 1',
    ).get(sourceId)).toMatchObject({ text: expect.stringContaining('русский текст') });
  });

  it('продолжает после частичного отказа и повторяет только заданный диапазон', async () => {
    runner.fail.add(2);
    const worker = new CatalogWorker(db, dir, { runner });
    worker.enqueueSource(sourceId);
    await worker.drainNow();
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'failed', job: { status: 'failed' },
      pages: [{ status: 'ready' }, { status: 'failed' }, { status: 'suspicious' }],
    });
    expect(worker.status()).toMatchObject({ state: 'degraded', failed: 1 });

    runner.fail.clear();
    worker.retrySource(sourceId, { fromPage: 2, toPage: 2 });
    await worker.drainNow();
    expect(runner.calls).toEqual([1, 2, 3, 2]);
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'ready', job: { status: 'succeeded', attempts: 2 },
    });
  });

  it('после рестарта возвращает running job/page в очередь', () => {
    const first = new CatalogWorker(db, dir, { runner });
    const jobId = first.enqueueSource(sourceId);
    db.prepare("UPDATE catalog_jobs SET status = 'running' WHERE id = ?").run(jobId);
    db.prepare("UPDATE source_pages SET status = 'processing' WHERE source_id = ? AND page_number = 1")
      .run(sourceId);

    const restarted = new CatalogWorker(db, dir, { runner });
    expect(restarted.sourceStatus(sourceId)).toMatchObject({
      job: { status: 'queued' },
      pages: [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
    });
  });

  it('останавливает runner и оставляет незавершённую работу возобновляемой', async () => {
    const worker = new CatalogWorker(db, dir, { runner });
    worker.enqueueSource(sourceId);
    await worker.stop();
    expect(runner.stopped).toBe(true);
    expect(worker.status().state).toBe('stopping');
  });
});
