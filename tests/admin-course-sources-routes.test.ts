import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE } from '../server/auth.js';
import { CourseArtifactStore } from '../server/course-artifacts.js';
import { CatalogWorker } from '../server/catalog-worker.js';
import { createCourse, publishRevision, replaceDraftTopics } from '../server/course-catalog.js';
import { listAdminAudit, openControlDatabase } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { registerAdminCoursesRoutes } from '../server/routes/admin/courses.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import { createAdminAccount, signInAdmin } from './server-harness.js';
import type { OcrRunner } from '../server/ocr-runner.js';

const NOW = new Date('2026-08-22T10:00:00.000Z');
const PDF = Buffer.from('%PDF-1.7\nroute fixture\n%%EOF\n');

function multipart(filename: string, content: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----edukator-course-source';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe('admin API источников курса', () => {
  let dir: string;
  let db: Database;
  let app: FastifyInstance;
  let cookie: string;
  let draftId: number;
  let catalogWorker: CatalogWorker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-source-routes-'));
    ensureDataDir(dir);
    db = openControlDatabase(controlDatabasePath(dir));
    const admin = signInAdmin(db, createAdminAccount(db, { now: NOW }), NOW);
    cookie = `${ADMIN_COOKIE}=${admin.token}`;
    draftId = createCourse(db, { id: 'history-6', title: 'История', grade: '6 класс' }).draft.id;
    const artifacts = new CourseArtifactStore(db, dir, {
      inspector: { inspect: async () => ({ pageCount: 2 }) },
      maxBytes: 128,
      now: () => NOW,
    });
    const runner: OcrRunner = {
      checkDependencies: async () => undefined,
      processPage: async ({ pageNumber }) => ({
        text: `Распознанный русский текст страницы ${pageNumber}`,
        image: Buffer.from(`image-${pageNumber}`),
      }),
      stop: async () => undefined,
    };
    catalogWorker = new CatalogWorker(db, dir, { runner, now: () => NOW });
    app = Fastify();
    registerAdminCoursesRoutes(app, {
      context: createAdminContext({ control: db, now: () => NOW }),
      control: db,
      dataDir: dir,
      artifacts,
      catalogWorker,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function upload(filename: string, content = PDF, auth = cookie) {
    const encoded = multipart(filename, content);
    return app.inject({
      method: 'POST',
      url: '/api/admin/courses/history-6/sources',
      headers: {
        cookie: auth,
        'sec-fetch-site': 'same-origin',
        'content-type': encoded.contentType,
      },
      payload: encoded.body,
    });
  }

  it('загружает, дедуплицирует, перечисляет и удаляет PDF draft', async () => {
    const created = await upload('../../private-book.pdf');
    expect(created.statusCode).toBe(201);
    const source = (created.json() as { source: { id: number; uploadName: string } }).source;
    expect(source.uploadName).toBe('private-book.pdf');

    const duplicate = await upload('copy.pdf');
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, source: { id: source.id } });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/courses/history-6/sources',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ sources: [{ id: source.id, pageCount: 2 }] });
    expect(JSON.stringify(listed.json())).not.toContain('artifact_path');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/courses/history-6/sources/${source.id}`,
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: '/api/admin/courses/history-6/sources',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })).json()).toEqual({ sources: [] });
    expect(listAdminAudit(db, { limit: 10 }).entries.map((entry) => entry.action))
      .toEqual(['course-update', 'course-update', 'course-update']);
  });

  it('применяет multipart/signature limits и не создаёт частичных строк', async () => {
    expect((await upload('large.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(256)]))).statusCode)
      .toBe(413);
    expect((await upload('fake.pdf', Buffer.from('not-pdf'))).statusCode).toBe(400);
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM course_sources').get()?.count)
      .toBe(0);
  });

  it('показывает page-level OCR status и ставит диапазон на retry с аудитом', async () => {
    const created = await upload('ocr.pdf');
    const sourceId = (created.json() as { source: { id: number } }).source.id;
    await catalogWorker.drainNow();

    const status = await app.inject({
      method: 'GET',
      url: `/api/admin/courses/history-6/sources/${sourceId}/status`,
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      sourceStatus: 'ready', job: { status: 'succeeded' },
      pages: [{ pageNumber: 1, status: 'ready' }, { pageNumber: 2, status: 'ready' }],
    });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/admin/courses/history-6/sources/${sourceId}/retry`,
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      payload: { fromPage: 2, toPage: 2 },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: { job: { status: 'queued' } } });
    expect(listAdminAudit(db, { limit: 10 }).entries[0]?.action).toBe('course-retry');
  });

  it('запрещает не-admin и удаление опубликованного источника', async () => {
    expect((await upload('forbidden.pdf', PDF, '')).statusCode).toBe(401);
    const created = await upload('book.pdf');
    const sourceId = (created.json() as { source: { id: number } }).source.id;
    const topics = replaceDraftTopics(db, 'history-6', draftId, 1, [{
      clientId: 'ancient', title: 'Древний мир', examWeight: 1, difficulty: 1,
      prereqs: [], answerFormat: 'text', promptSeed: 'Древние государства',
    }], { createTopicToken: () => 'ancient' });
    publishRevision(db, 'history-6', draftId, topics.revision.editVersion);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/courses/history-6/sources/${sourceId}`,
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(removed.statusCode).toBe(409);
  });
});
