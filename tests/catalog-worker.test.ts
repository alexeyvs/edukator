import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogWorker } from '../server/catalog-worker.js';
import { CourseArtifactStore } from '../server/course-artifacts.js';
import { createCourse } from '../server/course-catalog.js';
import { openControlDatabase } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import type { OcrPageRequest, OcrPageResult, OcrRunner } from '../server/ocr-runner.js';
import { OcrStoppedError } from '../server/ocr-runner.js';

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

class BlockingRunner extends FakeRunner {
  active = 0;
  maxActive = 0;
  private releasePage: (() => void) | undefined;
  private enteredResolve: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });

  override async processPage(request: OcrPageRequest): Promise<OcrPageResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.enteredResolve();
    await new Promise<void>((resolve) => { this.releasePage = resolve; });
    try { return await super.processPage(request); } finally { this.active -= 1; }
  }

  release(): void { this.releasePage?.(); }
  override async stop(): Promise<void> { await super.stop(); this.release(); }
}

class RejectingStopRunner extends FakeRunner {
  private rejectPage: ((error: Error) => void) | undefined;
  private enteredResolve: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });

  override async processPage(): Promise<OcrPageResult> {
    this.enteredResolve();
    return new Promise<OcrPageResult>((_resolve, reject) => { this.rejectPage = reject; });
  }

  override async stop(): Promise<void> {
    await super.stop();
    this.rejectPage?.(new OcrStoppedError('Команда остановлена'));
  }
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
    runner.fail.add(3);
    const worker = new CatalogWorker(db, dir, { runner });
    worker.enqueueSource(sourceId);
    await worker.drainNow();
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'failed', job: { status: 'failed' },
      pages: [{ status: 'ready' }, { status: 'failed' }, { status: 'failed' }],
    });
    expect(worker.status()).toMatchObject({ state: 'degraded', failed: 1 });

    runner.fail.delete(2);
    worker.retrySource(sourceId, { fromPage: 2, toPage: 2 });
    await worker.drainNow();
    expect(runner.calls).toEqual([1, 2, 3, 2]);
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'failed', job: { status: 'failed', attempts: 2 },
      pages: [{ status: 'ready' }, { status: 'ready' }, { status: 'failed' }],
    });

    runner.fail.clear();
    worker.retrySource(sourceId, { fromPage: 3, toPage: 3 });
    await worker.drainNow();
    expect(runner.calls).toEqual([1, 2, 3, 2, 3]);
    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'ready', job: { status: 'succeeded', attempts: 3 },
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

  it('после рестарта помечает прерванную сборку failed для явного retry', () => {
    db.prepare(`INSERT INTO catalog_jobs
      (job_key, type, status, course_id, revision_id)
      VALUES ('build:test', 'build-curriculum', 'running', 'geography-5',
        (SELECT revision_id FROM course_sources WHERE id = ?))`).run(sourceId);
    new CatalogWorker(db, dir, { runner });
    expect(db.prepare("SELECT status, error FROM catalog_jobs WHERE job_key = 'build:test'").get())
      .toMatchObject({ status: 'failed', error: expect.stringContaining('повторно') });
  });

  it('валидирует retry, поддерживает defaults и безопасные lifecycle no-op', async () => {
    const worker = new CatalogWorker(db, dir, { runner, autoPollMs: 60_000 });
    expect(worker.sourceStatus(sourceId).job).toBeNull();
    expect(() => worker.sourceStatus(-1)).toThrow(/не найден/u);
    for (const range of [
      { fromPage: 0 }, { fromPage: 2, toPage: 1 }, { toPage: 4 }, { fromPage: 1.5 },
    ]) expect(() => worker.retrySource(sourceId, range)).toThrow(RangeError);
    const jobId = worker.retrySource(sourceId);
    expect(jobId).toBeGreaterThan(0);
    worker.start();
    worker.start();
    await worker.drainNow();
    await worker.stop();
    worker.start();
    await worker.drainNow();
    expect(worker.status().state).toBe('stopping');
  });

  it('сериализует конкурентные wake и возобновляет активную страницу после stop', async () => {
    const blocking = new BlockingRunner();
    const worker = new CatalogWorker(db, dir, { runner: blocking });
    worker.enqueueSource(sourceId);
    const first = worker.drainNow();
    await blocking.entered;
    const second = worker.drainNow();
    worker.wake();
    expect(blocking.maxActive).toBe(1);
    const stopping = worker.stop();
    await Promise.all([first, second, stopping]);
    expect(worker.sourceStatus(sourceId).job).toMatchObject({ status: 'queued' });

    const resumedRunner = new FakeRunner();
    const resumed = new CatalogWorker(db, dir, { runner: resumedRunner });
    await resumed.drainNow();
    expect(resumedRunner.calls.length).toBeGreaterThan(0);
    expect(resumed.sourceStatus(sourceId)).toMatchObject({ sourceStatus: 'ready', job: { status: 'succeeded' } });
  });

  it('не превращает остановленную runner страницу в постоянный OCR-отказ', async () => {
    const stoppingRunner = new RejectingStopRunner();
    const worker = new CatalogWorker(db, dir, { runner: stoppingRunner });
    worker.enqueueSource(sourceId);
    const processing = worker.drainNow();
    await stoppingRunner.entered;
    await Promise.all([processing, worker.stop()]);

    expect(worker.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'processing', job: { status: 'queued' },
      pages: [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
    });

    const resumed = new CatalogWorker(db, dir, { runner: new FakeRunner() });
    await resumed.drainNow();
    expect(resumed.sourceStatus(sourceId)).toMatchObject({
      sourceStatus: 'ready', job: { status: 'succeeded' },
    });
  });

  it('не позволяет повторить или удалить источник во время активного OCR', async () => {
    const blocking = new BlockingRunner();
    const worker = new CatalogWorker(db, dir, { runner: blocking });
    worker.enqueueSource(sourceId);
    const processing = worker.drainNow();
    await blocking.entered;

    expect(() => worker.retrySource(sourceId)).toThrow(/уже выполняется/u);
    const artifacts = new CourseArtifactStore(db, dir, {
      inspector: { inspect: async () => ({ pageCount: 3 }) },
    });
    await expect(artifacts.remove('geography-5', sourceId)).rejects.toThrow(/уже выполняется/u);
    expect(db.prepare('SELECT id FROM course_sources WHERE id = ?').get(sourceId)).toBeDefined();

    const stopping = worker.stop();
    await Promise.all([processing, stopping]);
  });

  it('останавливает runner и оставляет незавершённую работу возобновляемой', async () => {
    const worker = new CatalogWorker(db, dir, { runner });
    worker.enqueueSource(sourceId);
    await worker.stop();
    expect(runner.stopped).toBe(true);
    expect(worker.status().state).toBe('stopping');
  });
});
