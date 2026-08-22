import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  listAdminAudit,
  markChildReady,
  openControlDatabase,
  redeemDeviceInvite,
  redeemParentInvite,
  startImpersonation,
} from '../server/control-db.js';
import {
  ADMIN_COOKIE,
  CHILD_COOKIE,
  IMPERSONATION_COOKIE,
  PARENT_COOKIE,
} from '../server/auth.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import {
  registerAdminCoursesRoutes,
  registerUnavailableAdminCourses,
  CourseDraftBuildRunner,
} from '../server/routes/admin/courses.js';
import { createAdminAccount, signInAdmin } from './server-harness.js';

const NOW = new Date('2026-08-22T09:00:00.000Z');
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  json: () => unknown;
}

describe('админские маршруты каталога курсов', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminId: string;
  let adminCookie: string;
  let topicNumber: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-courses-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    const admin = signInAdmin(control, createAdminAccount(control, { now: NOW }), NOW);
    adminId = admin.adminId;
    adminCookie = `${ADMIN_COOKIE}=${admin.token}`;
    topicNumber = 0;

    app = Fastify();
    registerAdminCoursesRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
      now: () => NOW,
      createCourseId: () => 'generated-course',
      createTopicToken: () => `topic-${++topicNumber}`,
      draftBuilder: async () => ({}),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: object,
    cookie = adminCookie,
  ): Promise<Injected> {
    if (payload === undefined) {
      return app.inject({ method, url, headers: { ...SAME_ORIGIN, cookie } });
    }
    return app.inject({ method, url, headers: { ...SAME_ORIGIN, cookie }, payload });
  }

  async function createBiology() {
    const response = await request('POST', '/api/admin/courses', {
      id: 'biology-7',
      title: 'Биология',
      grade: '7 класс',
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      course: { id: string; status: string; activeRevisionId: number | null };
      draft: { id: number; editVersion: number; status: string };
    };
  }

  function topicsPayload(revisionId: number, editVersion: number) {
    return {
      revisionId,
      editVersion,
      topics: [
        {
          clientId: 'cells',
          title: 'Клетка',
          examWeight: 2,
          difficulty: 1,
          prereqs: [],
          answerFormat: 'text',
          promptSeed: 'Строение клетки',
        },
        {
          clientId: 'tissues',
          title: 'Ткани',
          examWeight: 2,
          difficulty: 2,
          prereqs: ['cells'],
          answerFormat: 'choice',
          promptSeed: 'Типы тканей',
        },
      ],
    };
  }

  it('проходит полный цикл create, edit, publish, draft и archive', async () => {
    const created = await createBiology();
    const listed = await request('GET', '/api/admin/courses');
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { courses: { id: string }[] }).courses.map((course) => course.id))
      .toContain('biology-7');

    const replaced = await request(
      'PUT',
      '/api/admin/courses/biology-7/draft/topics',
      topicsPayload(created.draft.id, created.draft.editVersion),
    );
    expect(replaced.statusCode).toBe(200);
    const edited = replaced.json() as {
      revision: { id: number; editVersion: number };
      topics: { id: string; prereqs: string[] }[];
    };
    expect(edited.topics.map((topic) => topic.id)).toEqual([
      'biology-7.topic-1',
      'biology-7.topic-2',
    ]);
    expect(edited.topics[1]?.prereqs).toEqual(['biology-7.topic-1']);

    const metadata = await request('PATCH', '/api/admin/courses/biology-7', {
      revisionId: edited.revision.id,
      editVersion: edited.revision.editVersion,
      title: 'Общая биология',
      grade: '7–8 класс',
    });
    expect(metadata.statusCode).toBe(200);
    const metadataRevision = (metadata.json() as { revision: { editVersion: number } }).revision;

    const published = await request('POST', '/api/admin/courses/biology-7/publish', {
      revisionId: edited.revision.id,
      editVersion: metadataRevision.editVersion,
      idempotencyKey: 'publish-biologia-v1',
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ idempotent: false, revision: { status: 'published' } });

    const repeated = await request('POST', '/api/admin/courses/biology-7/publish', {
      revisionId: edited.revision.id,
      editVersion: metadataRevision.editVersion,
      idempotencyKey: 'publish-biologia-v1',
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ idempotent: true, revision: { id: edited.revision.id } });

    const nextDraft = await request('POST', '/api/admin/courses/biology-7/draft', {
      activeRevisionId: edited.revision.id,
    });
    expect(nextDraft.statusCode).toBe(201);
    expect(nextDraft.json()).toMatchObject({
      revision: { revisionNumber: 2, basedOnRevisionId: edited.revision.id },
      topics: [{ title: 'Клетка' }, { title: 'Ткани' }],
    });

    const card = await request('GET', '/api/admin/courses/biology-7');
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({
      course: { title: 'Общая биология', status: 'published' },
      revisions: [
        { revisionNumber: 2, status: 'draft' },
        { revisionNumber: 1, status: 'published' },
      ],
    });

    const archived = await request('POST', '/api/admin/courses/biology-7/archive', {});
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ course: { status: 'archived' }, idempotent: false });
    const repeatedArchive = await request('POST', '/api/admin/courses/biology-7/archive', {});
    expect(repeatedArchive.json()).toMatchObject({ course: { status: 'archived' }, idempotent: true });

    expect(listAdminAudit(control, { limit: 20 }).entries.map((entry) => entry.action)).toEqual([
      'course-archive',
      'course-update',
      'course-publish',
      'course-update',
      'course-update',
      'course-create',
    ]);
  });

  it('отвергает невалидный граф и optimistic edit conflict без частичной записи', async () => {
    const created = await createBiology();
    const invalid = await request('PUT', '/api/admin/courses/biology-7/draft/topics', {
      revisionId: created.draft.id,
      editVersion: created.draft.editVersion,
      topics: [{
        clientId: 'broken',
        title: 'Битая тема',
        examWeight: 1,
        difficulty: 1,
        prereqs: ['missing'],
        answerFormat: 'text',
        promptSeed: 'Неважно',
      }],
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await request(
      'PUT',
      '/api/admin/courses/biology-7/draft/topics',
      topicsPayload(created.draft.id, created.draft.editVersion),
    );
    expect(valid.statusCode).toBe(200);
    const conflict = await request(
      'PUT',
      '/api/admin/courses/biology-7/draft/topics',
      topicsPayload(created.draft.id, created.draft.editVersion),
    );
    expect(conflict.statusCode).toBe(409);
    expect(listAdminAudit(control, { limit: 20 }).entries.map((entry) => entry.action)).toEqual([
      'course-update',
      'course-create',
    ]);
  });

  it('не публикует черновик во время его фоновой сборки', async () => {
    const created = await createBiology();
    const replaced = await request(
      'PUT', '/api/admin/courses/biology-7/draft/topics',
      topicsPayload(created.draft.id, created.draft.editVersion),
    );
    const revision = (replaced.json() as { revision: { editVersion: number } }).revision;
    control.prepare(
      `INSERT INTO catalog_jobs (job_key, type, status, course_id, revision_id)
       VALUES (?, 'build-curriculum', 'running', 'biology-7', ?)`,
    ).run(`build:${String(created.draft.id)}`, created.draft.id);

    const response = await request('POST', '/api/admin/courses/biology-7/publish', {
      revisionId: created.draft.id,
      editVersion: revision.editVersion,
      idempotencyKey: 'publish-during-build',
    });
    expect(response.statusCode).toBe(409);
    expect(control.prepare<[number], { status: string }>(
      'SELECT status FROM course_revisions WHERE id = ?',
    ).get(created.draft.id)?.status).toBe('draft');
  });

  it('отменяет и дожидается принадлежащих серверу фоновых сборок', async () => {
    let cancelled = false;
    const runner = new CourseDraftBuildRunner(({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        cancelled = true;
        reject(new Error('cancelled'));
      }, { once: true });
    }));
    runner.start({
      db: control, courseId: 'biology-7', revisionId: 1, expectedEditVersion: 1, dataDir: dir,
    });
    await runner.stop();
    expect(cancelled).toBe(true);
    expect(() => runner.start({
      db: control, courseId: 'biology-7', revisionId: 1, expectedEditVersion: 1, dataDir: dir,
    })).toThrow(/завершает работу/u);
  });

  it('строго ограничивает поля и размеры запросов', async () => {
    expect((await request('POST', '/api/admin/courses', {
      id: 'biology-7', title: 'Биология', grade: '7', extra: true,
    })).statusCode).toBe(400);
    expect((await request('POST', '/api/admin/courses', {
      id: 'overall', title: 'Общее', grade: '7',
    })).statusCode).toBe(400);
    expect((await request('POST', '/api/admin/courses', {
      title: 'x'.repeat(201), grade: '7',
    })).statusCode).toBe(400);
    expect(listAdminAudit(control, { limit: 20 }).entries).toEqual([]);
  });

  it('покрывает чтение draft/build и безопасные отказы status/retry', async () => {
    const created = await createBiology();
    expect((await request('GET', '/api/admin/courses/biology-7/draft')).json()).toMatchObject({
      revision: { id: created.draft.id }, topics: [],
    });
    expect((await request('GET', '/api/admin/courses/biology-7/draft/build')).json()).toEqual({
      revisionId: created.draft.id, job: null,
    });
    expect((await request('POST', '/api/admin/courses/biology-7/draft/build', {
      revisionId: created.draft.id, editVersion: created.draft.editVersion,
    })).statusCode).toBe(202);
    expect((await request('POST', '/api/admin/courses/biology-7/draft/build', {
      revisionId: created.draft.id, editVersion: created.draft.editVersion + 1,
    })).statusCode).toBe(409);

    const sourceId = Number(control.prepare(
      `INSERT INTO course_sources
         (course_id, revision_id, upload_name, sha256, artifact_path, page_count, status)
       VALUES ('biology-7', ?, 'scan.pdf', ?, 'catalog/artifacts/biology-7/scan.pdf', 2, 'failed')`,
    ).run(created.draft.id, 'a'.repeat(64)).lastInsertRowid);
    expect((await request('GET', `/api/admin/courses/biology-7/sources/${String(sourceId)}/status`)).statusCode)
      .toBe(503);
    expect((await request('POST', `/api/admin/courses/biology-7/sources/${String(sourceId)}/retry`, {
      fromPage: 1, toPage: 2,
    })).statusCode).toBe(503);

    expect((await request('GET', '/api/admin/courses/missing')).statusCode).toBe(404);
    expect((await request('GET', '/api/admin/courses/missing/draft')).statusCode).toBe(404);
    expect((await request('GET', '/api/admin/courses/missing/draft/build')).statusCode).toBe(404);
    expect((await request('POST', '/api/admin/courses/biology-7/draft/build', {
      revisionId: 999, editVersion: 1,
    })).statusCode).toBe(404);
  });

  it('отвергает неверные формы полей редактора и публикации', async () => {
    const created = await createBiology();
    const invalidPayloads = [
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: 'not-array' },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [null] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 4, difficulty: 1, prereqs: [],
        answerFormat: 'text', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 1, difficulty: 0, prereqs: [],
        answerFormat: 'binary', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 1, difficulty: 1, prereqs: 'bad',
        answerFormat: 'text', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        title: 'Тема', examWeight: 1, difficulty: 1, prereqs: [],
        answerFormat: 'text', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 1, difficulty: 1, prereqs: [''],
        answerFormat: 'text', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 1, difficulty: 1, prereqs: [42],
        answerFormat: 'text', promptSeed: 'Основа',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: [{
        clientId: 'x', title: 'Тема', examWeight: 1, difficulty: 1, prereqs: [],
        answerFormat: 'text', promptSeed: 'Основа', active: 'yes',
      }] },
      { revisionId: created.draft.id, editVersion: created.draft.editVersion, topics: Array.from(
        { length: 501 }, () => ({}),
      ) },
    ];
    for (const payload of invalidPayloads) {
      expect((await request('PUT', '/api/admin/courses/biology-7/draft/topics', payload)).statusCode)
        .toBe(400);
    }
    const stableTopic = await request('PUT', '/api/admin/courses/biology-7/draft/topics', {
      revisionId: created.draft.id,
      editVersion: created.draft.editVersion,
      topics: [{
        id: 'biology-7.fixed', title: 'Готовая тема', examWeight: 0, difficulty: 3,
        prereqs: [], answerFormat: 'number', promptSeed: 'Проверка', active: false,
      }],
    });
    expect(stableTopic.statusCode).toBe(200);
    expect(stableTopic.json()).toMatchObject({ topics: [{ id: 'biology-7.fixed', active: false }] });
    expect((await request('POST', '/api/admin/courses', {
      title: 'Курс с авто-ID', grade: '7 класс',
    })).json()).toMatchObject({ course: { id: 'course-generated-course' } });
    expect((await request('PATCH', '/api/admin/courses/biology-7', {
      revisionId: created.draft.id, editVersion: created.draft.editVersion,
      title: '', grade: '7',
    })).statusCode).toBe(400);
    expect((await request('POST', '/api/admin/courses/biology-7/publish', {
      revisionId: created.draft.id, editVersion: created.draft.editVersion,
      idempotencyKey: '',
    })).statusCode).toBe(400);
    expect((await request('GET', `/api/admin/courses/${'x'.repeat(81)}`)).statusCode).toBe(400);
    expect((await request('GET', '/api/admin/courses/overall')).statusCode).toBe(400);
    expect((await request('GET', '/api/admin/courses/biology-7/sources/not-a-number/status')).statusCode)
      .toBe(400);
    expect((await request('GET', '/api/admin/courses/biology-7/sources/0/status')).statusCode)
      .toBe(400);
    expect((await request('POST', '/api/admin/courses/biology-7/archive')).statusCode).toBe(200);
  });

  it('пускает только admin cookie и отвергает parent, child и impersonation', async () => {
    const parentId = createParent(control, 'family@example.com', NOW);
    const parentInvite = issueParentInvite(control, parentId, NOW);
    const parent = redeemParentInvite(control, parentInvite.token, 'пароль-родителя', NOW);
    if (!parent.ok) throw new Error('родитель не вошёл');

    const childId = createChild(control, parentId, 'Ученик', NOW);
    markChildReady(control, childId);
    const deviceInvite = issueDeviceInvite(control, childId, 'browser', 'Ноутбук', NOW);
    const child = redeemDeviceInvite(control, deviceInvite.token, NOW);
    if (!child.ok) throw new Error('устройство не вошло');

    const impersonation = startImpersonation(control, { adminId, childId, role: 'parent' }, NOW);
    if (!impersonation.ok) throw new Error('заход не создан');

    const cookies = [
      '',
      `${PARENT_COOKIE}=${parent.session.token}`,
      `${CHILD_COOKIE}=${child.token}`,
      `${IMPERSONATION_COOKIE}=${impersonation.session.token}`,
    ];
    for (const cookie of cookies) {
      const get = await request('GET', '/api/admin/courses', undefined, cookie);
      expect([401, 403]).toContain(get.statusCode);
      const post = await request('POST', '/api/admin/courses', {
        id: 'forbidden-course', title: 'Нельзя', grade: '7',
      }, cookie);
      expect([401, 403]).toContain(post.statusCode);
    }
    expect((await request('GET', '/api/admin/courses')).statusCode).toBe(200);
  });

  it('не пишет названия, prompt seed, idempotency key и локальные пути в аудит', async () => {
    const created = await request('POST', '/api/admin/courses', {
      id: 'private-course',
      title: 'Секретное название учебника',
      grade: '/srv/private/books/7',
    });
    const draft = (created.json() as { draft: { id: number; editVersion: number } }).draft;
    await request('PUT', '/api/admin/courses/private-course/draft/topics', {
      revisionId: draft.id,
      editVersion: draft.editVersion,
      topics: [{
        clientId: 'one', title: 'Секретная тема', examWeight: 1, difficulty: 1,
        prereqs: [], answerFormat: 'text', promptSeed: 'Содержимое учебника',
      }],
    });
    const audit = JSON.stringify(listAdminAudit(control, { limit: 20 }).entries);
    expect(audit).not.toContain('Секретное название');
    expect(audit).not.toContain('Секретная тема');
    expect(audit).not.toContain('Содержимое учебника');
    expect(audit).not.toContain('/srv/private');
  });

  it('unavailable-вариант отвечает 503 на все адреса задачи', async () => {
    const unavailable = Fastify();
    registerUnavailableAdminCourses(unavailable, 'управляющая база недоступна');
    await unavailable.ready();
    try {
      const requests = [
        { method: 'GET', url: '/api/admin/courses' },
        { method: 'POST', url: '/api/admin/courses' },
        { method: 'GET', url: '/api/admin/courses/x' },
        { method: 'PATCH', url: '/api/admin/courses/x' },
        { method: 'GET', url: '/api/admin/courses/x/draft' },
        { method: 'POST', url: '/api/admin/courses/x/draft' },
        { method: 'PUT', url: '/api/admin/courses/x/draft/topics' },
        { method: 'POST', url: '/api/admin/courses/x/publish' },
        { method: 'GET', url: '/api/admin/courses/x/draft/build' },
        { method: 'POST', url: '/api/admin/courses/x/draft/build' },
        { method: 'POST', url: '/api/admin/courses/x/archive' },
        { method: 'GET', url: '/api/admin/courses/x/sources' },
        { method: 'POST', url: '/api/admin/courses/x/sources' },
        { method: 'DELETE', url: '/api/admin/courses/x/sources/1' },
        { method: 'GET', url: '/api/admin/courses/x/sources/1/status' },
        { method: 'POST', url: '/api/admin/courses/x/sources/1/retry' },
      ] as const;
      for (const item of requests) {
        expect((await unavailable.inject(item)).statusCode, `${item.method} ${item.url}`).toBe(503);
      }
    } finally {
      await unavailable.close();
    }
  });
});
