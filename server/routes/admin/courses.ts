import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
  app.post('/api/admin/courses/:courseId/archive', send);
}
