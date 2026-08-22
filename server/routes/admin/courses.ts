import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import {
  ANSWER_FORMATS,
  type AnswerFormat,
} from '../../curriculum.js';
import { isCourseId, type CourseId } from '../../db.js';
import {
  archiveCourse,
  CatalogConflictError,
  CatalogNotFoundError,
  createCourse,
  createDraft,
  listCourseRevisions,
  listCourses,
  PublishedRevisionError,
  publishRevision,
  readCourse,
  readRevision,
  readRevisionTopics,
  replaceDraftTopics,
  updateCourseMetadata,
  type DraftTopicInput,
} from '../../course-catalog.js';
import { recordAdminAudit } from '../../control-db.js';
import {
  ArtifactNotFoundError,
  ArtifactStorageError,
  ArtifactTooLargeError,
  ArtifactValidationError,
  CourseArtifactStore,
} from '../../course-artifacts.js';
import { dataDir as defaultDataDir } from '../../data-dir.js';
import type { CatalogWorker } from '../../catalog-worker.js';
import { buildCourseDraft, type BuildCourseDraftOptions } from '../../course-drafting.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export const COURSE_ID_MAX_LENGTH = 80;
export const COURSE_TITLE_MAX_LENGTH = 200;
export const COURSE_GRADE_MAX_LENGTH = 80;
export const COURSE_TOPICS_MAX = 500;
export const TOPIC_ID_MAX_LENGTH = 180;
export const TOPIC_TITLE_MAX_LENGTH = 300;
export const TOPIC_PROMPT_SEED_MAX_LENGTH = 4_000;
export const TOPIC_PREREQS_MAX = 100;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface AdminCoursesRoutesOptions {
  context: AdminContextResolver;
  control: Database;
  now?: () => Date;
  createCourseId?: () => string;
  createTopicToken?: () => string;
  dataDir?: string;
  artifacts?: CourseArtifactStore;
  catalogWorker?: CatalogWorker;
  draftBuilder?: (options: BuildCourseDraftOptions) => Promise<unknown>;
}

class RequestValidationError extends Error {}

function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError('Тело запроса должно быть объектом');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new RequestValidationError('Тело запроса содержит неизвестные поля');
  }
  return body;
}

function textField(
  body: Record<string, unknown>,
  name: string,
  maxLength: number,
  options: { optional?: boolean } = {},
): string | undefined {
  const value = body[name];
  if (value === undefined && options.optional === true) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new RequestValidationError(`Поле ${name} должно быть непустой строкой до ${maxLength} символов`);
  }
  return value.trim();
}

function integerField(
  body: Record<string, unknown>,
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestValidationError(`Поле ${name} должно быть целым числом от ${min} до ${max}`);
  }
  return value;
}

function courseIdParam(params: unknown): CourseId {
  const courseId = (params as { courseId?: unknown }).courseId;
  if (typeof courseId !== 'string' || courseId.length > COURSE_ID_MAX_LENGTH || !isCourseId(courseId)) {
    throw new RequestValidationError('Некорректный идентификатор курса');
  }
  return courseId;
}

function sourceIdParam(params: unknown): number {
  const rawSourceId = (params as { sourceId?: unknown }).sourceId;
  const sourceId = typeof rawSourceId === 'string' ? Number(rawSourceId) : Number.NaN;
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
    throw new RequestValidationError('Некорректный идентификатор источника');
  }
  return sourceId;
}

function requireOwnedSource(
  control: Database,
  courseId: CourseId,
  sourceId: number,
  draftOnly = false,
): void {
  const source = control.prepare<[number], { course_id: string; revision_status: 'draft' | 'published' }>(
    `SELECT cs.course_id, cr.status AS revision_status
       FROM course_sources cs JOIN course_revisions cr ON cr.id = cs.revision_id
      WHERE cs.id = ?`,
  ).get(sourceId);
  if (source === undefined || source.course_id !== courseId) throw new ArtifactNotFoundError('Источник не найден');
  if (draftOnly && source.revision_status !== 'draft') {
    throw new PublishedRevisionError('OCR опубликованной редакции неизменяем');
  }
}

function emptyBody(value: unknown): void {
  if (value === undefined) return;
  objectBody(value, []);
}

function parseTopics(value: unknown): DraftTopicInput[] {
  if (!Array.isArray(value) || value.length > COURSE_TOPICS_MAX) {
    throw new RequestValidationError(`Поле topics должно быть массивом до ${COURSE_TOPICS_MAX} тем`);
  }
  return value.map((raw, index) => {
    const body = objectBody(raw, [
      'id', 'clientId', 'title', 'examWeight', 'difficulty', 'prereqs',
      'answerFormat', 'promptSeed', 'active',
    ]);
    const id = textField(body, 'id', TOPIC_ID_MAX_LENGTH, { optional: true });
    const clientId = textField(body, 'clientId', TOPIC_ID_MAX_LENGTH, { optional: true });
    if (id === undefined && clientId === undefined) {
      throw new RequestValidationError(`Тема ${index + 1}: нужен clientId для новой темы`);
    }
    const prereqs = body['prereqs'];
    if (!Array.isArray(prereqs) || prereqs.length > TOPIC_PREREQS_MAX || prereqs.some(
      (item) => typeof item !== 'string' || item.trim() === '' || item.length > TOPIC_ID_MAX_LENGTH,
    )) {
      throw new RequestValidationError(`Тема ${index + 1}: prereqs должен содержать корректные идентификаторы`);
    }
    const answerFormat = body['answerFormat'];
    if (typeof answerFormat !== 'string' || !ANSWER_FORMATS.includes(answerFormat as AnswerFormat)) {
      throw new RequestValidationError(`Тема ${index + 1}: неизвестный answerFormat`);
    }
    const active = body['active'];
    if (active !== undefined && typeof active !== 'boolean') {
      throw new RequestValidationError(`Тема ${index + 1}: active должен быть boolean`);
    }
    return {
      ...(id === undefined ? {} : { id }),
      ...(clientId === undefined ? {} : { clientId }),
      title: textField(body, 'title', TOPIC_TITLE_MAX_LENGTH) as string,
      examWeight: integerField(body, 'examWeight', 0, 3),
      difficulty: integerField(body, 'difficulty', 1, 3),
      prereqs: prereqs.map((item) => (item as string).trim()),
      answerFormat: answerFormat as AnswerFormat,
      promptSeed: textField(body, 'promptSeed', TOPIC_PROMPT_SEED_MAX_LENGTH) as string,
      ...(active === undefined ? {} : { active }),
    };
  });
}

function courseCard(control: Database, courseId: CourseId): object {
  const course = readCourse(control, courseId);
  if (course === undefined) throw new CatalogNotFoundError(`Курс «${courseId}» не найден`);
  const revisions = listCourseRevisions(control, courseId).map((revision) => ({
    ...revision,
    topics: readRevisionTopics(control, revision.id),
  }));
  return { course, revisions };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ArtifactTooLargeError) return reply.code(413).send({ error: error.message });
  if (error instanceof ArtifactValidationError) return reply.code(400).send({ error: error.message });
  if (error instanceof ArtifactNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof ArtifactStorageError) return reply.code(503).send({ error: error.message });
  if (error instanceof Error && /file too large|parts limit|files limit|request body is too large/iu.test(error.message)) {
    return reply.code(413).send({ error: 'PDF превышает допустимый размер multipart-запроса' });
  }
  if (error instanceof RequestValidationError) return reply.code(400).send({ error: error.message });
  if (error instanceof CatalogNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof CatalogConflictError || error instanceof PublishedRevisionError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof Error && /Карта тем|тема|предпосыл|цикл|не содержит|не принадлежит/iu.test(error.message)) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

function authorize(
  options: AdminCoursesRoutesOptions,
  request: Parameters<AdminContextResolver>[0],
  reply: FastifyReply,
  mutating = false,
): ReturnType<AdminContextResolver> | FastifyReply {
  try {
    return options.context(request, { allow: ROUTE_ACCESS.admin, ...(mutating ? { mutating: true } : {}) });
  } catch (error) {
    return failAuth(reply, error);
  }
}

function isReply(value: ReturnType<AdminContextResolver> | FastifyReply): value is FastifyReply {
  return 'send' in value && 'code' in value;
}

export function registerAdminCoursesRoutes(
  app: FastifyInstance,
  options: AdminCoursesRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());
  const artifacts = options.artifacts ?? new CourseArtifactStore(
    options.control,
    options.dataDir ?? defaultDataDir(),
    { now },
  );
  app.register(fastifyMultipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: artifacts.maxBytes },
  });

  app.get('/api/admin/courses', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    return reply.send({ courses: listCourses(options.control) });
  });

  app.post('/api/admin/courses', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const body = objectBody(request.body, ['id', 'title', 'grade']);
      const id = textField(body, 'id', COURSE_ID_MAX_LENGTH, { optional: true });
      if (id !== undefined && !isCourseId(id)) throw new RequestValidationError('Некорректный идентификатор курса');
      const at = now();
      const result = options.control.transaction(() => {
        const created = createCourse(options.control, {
          ...(id === undefined ? {} : { id }),
          title: textField(body, 'title', COURSE_TITLE_MAX_LENGTH) as string,
          grade: textField(body, 'grade', COURSE_GRADE_MAX_LENGTH) as string,
        }, { now: at, ...(options.createCourseId === undefined ? {} : { createId: options.createCourseId }) });
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-create',
          detail: `курс ${created.course.id}, редакция ${created.draft.id}`,
        }, at);
        return created;
      }).immediate();
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/admin/courses/:courseId', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    try {
      return reply.send(courseCard(options.control, courseIdParam(request.params)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/admin/courses/:courseId', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const body = objectBody(request.body, ['revisionId', 'editVersion', 'title', 'grade']);
      const at = now();
      const revision = options.control.transaction(() => {
        const updated = updateCourseMetadata(
          options.control,
          courseId,
          integerField(body, 'revisionId'),
          integerField(body, 'editVersion'),
          {
            title: textField(body, 'title', COURSE_TITLE_MAX_LENGTH) as string,
            grade: textField(body, 'grade', COURSE_GRADE_MAX_LENGTH) as string,
          },
          at,
        );
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-update',
          detail: `курс ${courseId}, метаданные редакции ${updated.id}, версия ${updated.editVersion}`,
        }, at);
        return updated;
      }).immediate();
      return reply.send({ course: readCourse(options.control, courseId), revision });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/admin/courses/:courseId/draft', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const draft = listCourseRevisions(options.control, courseId).find((revision) => revision.status === 'draft');
      if (draft === undefined) throw new CatalogNotFoundError(`У курса «${courseId}» нет черновика`);
      return reply.send({ revision: draft, topics: readRevisionTopics(options.control, draft.id) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/draft', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const body = objectBody(request.body, ['activeRevisionId']);
      const at = now();
      const draft = options.control.transaction(() => {
        const created = createDraft(options.control, courseId, integerField(body, 'activeRevisionId'), at);
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-update',
          detail: `курс ${courseId}, создан черновик ${created.id} из редакции ${created.basedOnRevisionId}`,
        }, at);
        return created;
      }).immediate();
      return reply.code(201).send({ revision: draft, topics: readRevisionTopics(options.control, draft.id) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put('/api/admin/courses/:courseId/draft/topics', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const body = objectBody(request.body, ['revisionId', 'editVersion', 'topics']);
      const at = now();
      const result = options.control.transaction(() => {
        const replaced = replaceDraftTopics(
          options.control,
          courseId,
          integerField(body, 'revisionId'),
          integerField(body, 'editVersion'),
          parseTopics(body['topics']),
          { now: at, ...(options.createTopicToken === undefined ? {} : { createTopicToken: options.createTopicToken }) },
        );
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-update',
          detail: `курс ${courseId}, темы редакции ${replaced.revision.id}, версия ${replaced.revision.editVersion}`,
        }, at);
        return replaced;
      }).immediate();
      return reply.send({ revision: result.revision, topics: readRevisionTopics(options.control, result.revision.id) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/publish', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const body = objectBody(request.body, ['revisionId', 'editVersion', 'idempotencyKey']);
      const revisionId = integerField(body, 'revisionId');
      const editVersion = integerField(body, 'editVersion');
      textField(body, 'idempotencyKey', IDEMPOTENCY_KEY_MAX_LENGTH);
      const existing = readRevision(options.control, revisionId);
      const course = readCourse(options.control, courseId);
      if (existing?.courseId === courseId && existing.status === 'published' && course?.activeRevisionId === revisionId) {
        return reply.send({ revision: existing, idempotent: true });
      }
      const at = now();
      const revision = options.control.transaction(() => {
        const published = publishRevision(options.control, courseId, revisionId, editVersion, {
          adminId: auth.admin.adminId,
          now: at,
        });
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-publish',
          detail: `курс ${courseId}, редакция ${published.id}`,
        }, at);
        return published;
      }).immediate();
      return reply.send({ revision, idempotent: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/admin/courses/:courseId/draft/build', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const revision = listCourseRevisions(options.control, courseId).find((item) => item.status === 'draft');
      if (revision === undefined) throw new CatalogNotFoundError(`У курса «${courseId}» нет черновика`);
      const job = options.control.prepare<[number], {
        id: number; status: string; attempts: number; error: string | null; updated_at: string;
      }>(
        `SELECT id, status, attempts, error, updated_at FROM catalog_jobs
          WHERE type = 'build-curriculum' AND revision_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(revision.id);
      return reply.send({ revisionId: revision.id, job: job === undefined ? null : {
        id: job.id, status: job.status, attempts: job.attempts, error: job.error, updatedAt: job.updated_at,
      } });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/draft/build', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const body = objectBody(request.body, ['revisionId', 'editVersion']);
      const revisionId = integerField(body, 'revisionId');
      const editVersion = integerField(body, 'editVersion');
      const revision = readRevision(options.control, revisionId);
      if (revision === undefined || revision.courseId !== courseId || revision.status !== 'draft') {
        throw new CatalogNotFoundError('Черновик курса не найден');
      }
      const running = options.control.prepare<[number], { id: number }>(
        "SELECT id FROM catalog_jobs WHERE type = 'build-curriculum' AND revision_id = ? AND status = 'running'",
      ).get(revisionId);
      if (running !== undefined) throw new CatalogConflictError(`Сборка черновика уже выполняется, job ${running.id}`);
      const builder = options.draftBuilder ?? buildCourseDraft;
      void builder({ db: options.control, courseId, revisionId, expectedEditVersion: editVersion,
        dataDir: options.dataDir ?? defaultDataDir(), now }).catch(() => undefined);
      recordAdminAudit(options.control, { adminId: auth.admin.adminId, action: 'course-retry',
        detail: `курс ${courseId}, сборка редакции ${revisionId}` }, now());
      return reply.code(202).send({ revisionId, status: 'running' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/archive', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      emptyBody(request.body);
      const existing = readCourse(options.control, courseId);
      if (existing === undefined) throw new CatalogNotFoundError(`Курс «${courseId}» не найден`);
      if (existing.status === 'archived') return reply.send({ course: existing, idempotent: true });
      const at = now();
      const course = options.control.transaction(() => {
        const archived = archiveCourse(options.control, courseId, at);
        recordAdminAudit(options.control, {
          adminId: auth.admin.adminId,
          action: 'course-archive',
          detail: `курс ${courseId}`,
        }, at);
        return archived;
      }).immediate();
      return reply.send({ course, idempotent: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/admin/courses/:courseId/sources', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    try {
      return reply.send({ sources: artifacts.list(courseIdParam(request.params)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/sources', async (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      if (!request.isMultipart()) throw new RequestValidationError('Ожидался multipart/form-data с одним PDF');
      const file = await request.file({
        limits: { files: 1, fields: 0, parts: 1, fileSize: artifacts.maxBytes },
      });
      if (file === undefined) throw new RequestValidationError('PDF-файл не передан');
      if (file.mimetype !== 'application/pdf') {
        file.file.resume();
        throw new ArtifactValidationError('Ожидался файл с типом application/pdf');
      }
      const at = now();
      const result = await artifacts.uploadToCurrentDraft(courseId, file.filename, file.file);
      if (!result.duplicate) options.catalogWorker?.enqueueSource(result.source.id);
      recordAdminAudit(options.control, {
        adminId: auth.admin.adminId,
        action: 'course-update',
        detail: `курс ${courseId}, источник ${result.source.id}, редакция ${result.source.revisionId}`,
      }, at);
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/admin/courses/:courseId/sources/:sourceId', async (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const sourceId = sourceIdParam(request.params);
      const removed = await artifacts.remove(courseId, sourceId);
      recordAdminAudit(options.control, {
        adminId: auth.admin.adminId,
        action: 'course-update',
        detail: `курс ${courseId}, удалён источник ${removed.id}, редакция ${removed.revisionId}`,
      }, now());
      return reply.send({ source: removed });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/admin/courses/:courseId/sources/:sourceId/status', (request, reply) => {
    const auth = authorize(options, request, reply);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const sourceId = sourceIdParam(request.params);
      requireOwnedSource(options.control, courseId, sourceId);
      if (options.catalogWorker === undefined) {
        return reply.code(503).send({ error: 'OCR worker отключён' });
      }
      return reply.send(options.catalogWorker.sourceStatus(sourceId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/admin/courses/:courseId/sources/:sourceId/retry', (request, reply) => {
    const auth = authorize(options, request, reply, true);
    if (isReply(auth)) return auth;
    try {
      const courseId = courseIdParam(request.params);
      const sourceId = sourceIdParam(request.params);
      requireOwnedSource(options.control, courseId, sourceId, true);
      if (options.catalogWorker === undefined) {
        return reply.code(503).send({ error: 'OCR worker отключён' });
      }
      const body = objectBody(request.body, ['fromPage', 'toPage']);
      const fromPage = body['fromPage'] === undefined ? undefined : integerField(body, 'fromPage');
      const toPage = body['toPage'] === undefined ? undefined : integerField(body, 'toPage');
      const jobId = options.catalogWorker.retrySource(sourceId, {
        ...(fromPage === undefined ? {} : { fromPage }),
        ...(toPage === undefined ? {} : { toPage }),
      });
      recordAdminAudit(options.control, {
        adminId: auth.admin.adminId,
        action: 'course-retry',
        detail: `курс ${courseId}, источник ${sourceId}, OCR job ${jobId}`,
      }, now());
      return reply.send({ jobId, status: options.catalogWorker.sourceStatus(sourceId) });
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      return sendError(reply, error);
    }
  });
}

export function registerUnavailableAdminCourses(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Каталог курсов недоступен: ${reason}` });
  app.get('/api/admin/courses', send);
  app.post('/api/admin/courses', send);
  app.get('/api/admin/courses/:courseId', send);
  app.patch('/api/admin/courses/:courseId', send);
  app.get('/api/admin/courses/:courseId/draft', send);
  app.post('/api/admin/courses/:courseId/draft', send);
  app.put('/api/admin/courses/:courseId/draft/topics', send);
  app.post('/api/admin/courses/:courseId/publish', send);
  app.get('/api/admin/courses/:courseId/draft/build', send);
  app.post('/api/admin/courses/:courseId/draft/build', send);
  app.post('/api/admin/courses/:courseId/archive', send);
  app.get('/api/admin/courses/:courseId/sources', send);
  app.post('/api/admin/courses/:courseId/sources', send);
  app.delete('/api/admin/courses/:courseId/sources/:sourceId', send);
  app.get('/api/admin/courses/:courseId/sources/:sourceId/status', send);
  app.post('/api/admin/courses/:courseId/sources/:sourceId/retry', send);
}
