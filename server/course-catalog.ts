import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, loadCurriculum, type AnswerFormat, type Topic, type TopicGraph } from './curriculum.js';
import { invalidateCatalogCurricula, invalidateChildCurriculum } from './curriculum-generation.js';
import { CURRICULUM_DIR } from './curriculum.js';
import { requireCourseId, type CourseId } from './db.js';
import { retrieveCourseSources } from './course-retrieval.js';

export class CatalogNotFoundError extends Error {}
export class CatalogConflictError extends Error {}
export class PublishedRevisionError extends Error {}

export interface CatalogCourse {
  id: CourseId;
  title: string;
  grade: string;
  status: 'draft' | 'published' | 'archived';
  activeRevisionId: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CatalogRevision {
  id: number;
  courseId: CourseId;
  revisionNumber: number;
  status: 'draft' | 'published';
  basedOnRevisionId: number | null;
  editVersion: number;
  title: string;
  grade: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface DraftTopicInput {
  /** Stable topic ID. Omit only for a newly-created topic. */
  id?: string;
  /** Temporary reference used by prereqs while the server assigns an ID. */
  clientId?: string;
  title: string;
  examWeight: number;
  difficulty: number;
  prereqs: string[];
  answerFormat: AnswerFormat;
  promptSeed: string;
  active?: boolean;
  /** Page evidence for this topic. Omit to preserve existing references. */
  sourceRefs?: TopicSourceRef[];
}

export interface TopicSourceRef {
  sourceId: number;
  pageFrom: number;
  pageTo: number;
}

export interface CatalogRevisionTopic extends Omit<DraftTopicInput, 'clientId'> {
  id: string;
  active: boolean;
  position: number;
}

interface CourseRow {
  id: string;
  title: string;
  grade: string;
  status: CatalogCourse['status'];
  active_revision_id: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RevisionRow {
  id: number;
  course_id: string;
  revision_number: number;
  status: CatalogRevision['status'];
  based_on_revision_id: number | null;
  edit_version: number;
  title: string;
  grade: string;
  published_by: string | null;
  created_at: string;
  published_at: string | null;
}

function toCourse(row: CourseRow): CatalogCourse {
  return {
    id: row.id,
    title: row.title,
    grade: row.grade,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toRevision(row: RevisionRow): CatalogRevision {
  return {
    id: row.id,
    courseId: row.course_id,
    revisionNumber: row.revision_number,
    status: row.status,
    basedOnRevisionId: row.based_on_revision_id,
    editVersion: row.edit_version,
    title: row.title,
    grade: row.grade,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} не может быть пустым`);
  return normalized;
}

function selectCourse(db: Database, courseId: string): CourseRow | undefined {
  return db.prepare<[string], CourseRow>('SELECT * FROM courses WHERE id = ?').get(courseId);
}

function selectRevision(db: Database, revisionId: number): RevisionRow | undefined {
  return db
    .prepare<[number], RevisionRow>('SELECT * FROM course_revisions WHERE id = ?')
    .get(revisionId);
}

function requireCourse(db: Database, courseId: string): CourseRow {
  const row = selectCourse(db, courseId);
  if (row === undefined) throw new CatalogNotFoundError(`Курс «${courseId}» не найден`);
  return row;
}

function requireEditableRevision(
  db: Database,
  courseId: string,
  revisionId: number,
  expectedEditVersion?: number,
): RevisionRow {
  const course = requireCourse(db, courseId);
  if (course.status === 'archived') {
    throw new CatalogConflictError(`Курс «${courseId}» архивирован`);
  }
  const row = selectRevision(db, revisionId);
  if (row === undefined || row.course_id !== courseId) {
    throw new CatalogNotFoundError(`Редакция ${revisionId} курса «${courseId}» не найдена`);
  }
  if (row.status !== 'draft') {
    throw new PublishedRevisionError(`Опубликованная редакция ${revisionId} неизменяема`);
  }
  if (expectedEditVersion !== undefined && row.edit_version !== expectedEditVersion) {
    throw new CatalogConflictError(
      `Черновик ${revisionId} уже изменён: ожидалась версия ${expectedEditVersion}, текущая ${row.edit_version}`,
    );
  }
  return row;
}

export function listCourses(db: Database): CatalogCourse[] {
  return db
    .prepare<[], CourseRow>('SELECT * FROM courses ORDER BY created_at, id')
    .all()
    .map(toCourse);
}

export function readCourse(db: Database, courseId: CourseId): CatalogCourse | undefined {
  const row = selectCourse(db, courseId);
  return row === undefined ? undefined : toCourse(row);
}

export function readRevision(db: Database, revisionId: number): CatalogRevision | undefined {
  const row = selectRevision(db, revisionId);
  return row === undefined ? undefined : toRevision(row);
}

export function listCourseRevisions(db: Database, courseId: CourseId): CatalogRevision[] {
  requireCourse(db, requireCourseId(courseId));
  return db
    .prepare<[string], RevisionRow>(
      'SELECT * FROM course_revisions WHERE course_id = ? ORDER BY revision_number DESC',
    )
    .all(courseId)
    .map(toRevision);
}

export function readRevisionTopics(db: Database, revisionId: number): CatalogRevisionTopic[] {
  if (selectRevision(db, revisionId) === undefined) {
    throw new CatalogNotFoundError(`Редакция ${revisionId} не найдена`);
  }
  const rows = db.prepare<
    [number],
    {
      topic_id: string;
      title: string;
      exam_weight: number;
      difficulty: number;
      answer_format: AnswerFormat;
      prompt_seed: string;
      position: number;
      active: number;
    }
  >(
    `SELECT topic_id, title, exam_weight, difficulty, answer_format, prompt_seed, position, active
       FROM revision_topics WHERE revision_id = ? ORDER BY position`,
  ).all(revisionId);
  const prereqs = db.prepare<[number], { topic_id: string; prereq_topic_id: string }>(
    `SELECT topic_id, prereq_topic_id FROM topic_prereqs
      WHERE revision_id = ? ORDER BY topic_id, position`,
  ).all(revisionId);
  const byTopic = new Map<string, string[]>();
  for (const row of prereqs) {
    byTopic.set(row.topic_id, [...(byTopic.get(row.topic_id) ?? []), row.prereq_topic_id]);
  }
  const sourceRows = db.prepare<[number], {
    topic_id: string; source_id: number; page_from: number; page_to: number;
  }>(`SELECT topic_id, source_id, page_from, page_to FROM revision_topic_sources
       WHERE revision_id = ? ORDER BY topic_id, source_id, page_from, page_to`).all(revisionId);
  const sourceRefs = new Map<string, TopicSourceRef[]>();
  for (const ref of sourceRows) {
    sourceRefs.set(ref.topic_id, [...(sourceRefs.get(ref.topic_id) ?? []), {
      sourceId: ref.source_id, pageFrom: ref.page_from, pageTo: ref.page_to,
    }]);
  }
  return rows.map((row) => ({
    id: row.topic_id,
    title: row.title,
    examWeight: row.exam_weight,
    difficulty: row.difficulty,
    prereqs: byTopic.get(row.topic_id) ?? [],
    answerFormat: row.answer_format,
    promptSeed: row.prompt_seed,
    active: row.active === 1,
    position: row.position,
    sourceRefs: sourceRefs.get(row.topic_id) ?? [],
  }));
}

export interface CreateCourseInput {
  id?: CourseId;
  title: string;
  grade: string;
}

export function createCourse(
  db: Database,
  input: CreateCourseInput,
  options: { now?: Date; createId?: () => string } = {},
): { course: CatalogCourse; draft: CatalogRevision } {
  const courseId = requireCourseId(input.id ?? `course-${(options.createId ?? randomUUID)()}`);
  const title = requireText(input.title, 'Название курса');
  const grade = requireText(input.grade, 'Класс курса');
  const at = (options.now ?? new Date()).toISOString();

  try {
    const revisionId = db.transaction((): number => {
      db.prepare(
        `INSERT INTO courses (id, title, grade, status, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?)`,
      ).run(courseId, title, grade, at, at);
      return Number(
        db.prepare(
          `INSERT INTO course_revisions
             (course_id, revision_number, status, edit_version, title, grade, created_at)
           VALUES (?, 1, 'draft', 1, ?, ?, ?)`,
        ).run(courseId, title, grade, at).lastInsertRowid,
      );
    }).immediate();
    return {
      course: toCourse(requireCourse(db, courseId)),
      draft: toRevision(selectRevision(db, revisionId) as RevisionRow),
    };
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: courses\.id/iu.test(error.message)) {
      throw new CatalogConflictError(`Курс «${courseId}» уже существует`);
    }
    throw error;
  }
}

export function createDraft(
  db: Database,
  courseId: CourseId,
  expectedActiveRevisionId: number,
  now: Date = new Date(),
): CatalogRevision {
  requireCourseId(courseId);
  const id = db.transaction((): number => {
    const course = requireCourse(db, courseId);
    if (course.status === 'archived') throw new CatalogConflictError(`Курс «${courseId}» архивирован`);
    if (course.active_revision_id !== expectedActiveRevisionId) {
      throw new CatalogConflictError(
        `Активная редакция курса «${courseId}» изменилась: ожидалась ${expectedActiveRevisionId}, текущая ${String(course.active_revision_id)}`,
      );
    }
    const existing = db
      .prepare<[string], RevisionRow>(
        "SELECT * FROM course_revisions WHERE course_id = ? AND status = 'draft'",
      )
      .get(courseId);
    if (existing !== undefined) {
      throw new CatalogConflictError(`У курса «${courseId}» уже есть черновик ${existing.id}`);
    }

    const nextNumber = Number(
      db
        .prepare<[string], { value: number }>(
          'SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM course_revisions WHERE course_id = ?',
        )
        .get(courseId)?.value ?? 1,
    );
    const result = db.prepare(
      `INSERT INTO course_revisions
         (course_id, revision_number, status, based_on_revision_id, edit_version, title, grade, created_at)
       SELECT ?, ?, 'draft', ?, 1, title, grade, ? FROM course_revisions WHERE id = ?`,
    ).run(courseId, nextNumber, expectedActiveRevisionId, now.toISOString(), expectedActiveRevisionId);
    const draftId = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO revision_topics
         (revision_id, topic_id, title, exam_weight, difficulty, answer_format, prompt_seed, position, active)
       SELECT ?, topic_id, title, exam_weight, difficulty, answer_format, prompt_seed, position, active
         FROM revision_topics WHERE revision_id = ?`,
    ).run(draftId, expectedActiveRevisionId);
    db.prepare(
      `INSERT INTO topic_prereqs (revision_id, topic_id, prereq_topic_id, position)
       SELECT ?, topic_id, prereq_topic_id, position FROM topic_prereqs WHERE revision_id = ?`,
    ).run(draftId, expectedActiveRevisionId);
    db.prepare(
      `INSERT INTO revision_topic_sources (revision_id, topic_id, source_id, page_from, page_to)
       SELECT ?, topic_id, source_id, page_from, page_to
         FROM revision_topic_sources WHERE revision_id = ?`,
    ).run(draftId, expectedActiveRevisionId);
    return draftId;
  }).immediate();
  return toRevision(selectRevision(db, id) as RevisionRow);
}

function materializeTopics(
  courseId: CourseId,
  inputs: readonly DraftTopicInput[],
  createTopicToken: () => string,
): Topic[] {
  const aliases = new Map<string, string>();
  const assigned = inputs.map((input) => {
    const stableId = input.id ?? `${courseId}.${createTopicToken()}`;
    if (!stableId.startsWith(`${courseId}.`)) {
      throw new Error(`Тема «${stableId}» не принадлежит курсу «${courseId}»`);
    }
    for (const alias of [input.id, input.clientId].filter((value): value is string => value !== undefined)) {
      if (aliases.has(alias)) throw new Error(`Тема «${alias}» дублируется`);
      aliases.set(alias, stableId);
    }
    aliases.set(stableId, stableId);
    return { input, stableId };
  });
  return assigned.map(({ input, stableId }): Topic => ({
    id: stableId,
    subject: courseId,
    title: requireText(input.title, `Название темы «${stableId}»`),
    examWeight: input.examWeight,
    difficulty: input.difficulty,
    prereqs: input.prereqs.map((prereq) => aliases.get(prereq) ?? prereq),
    answerFormat: input.answerFormat,
    promptSeed: requireText(input.promptSeed, `Основа заданий темы «${stableId}»`),
  }));
}

export function replaceDraftTopics(
  db: Database,
  courseId: CourseId,
  revisionId: number,
  expectedEditVersion: number,
  inputs: readonly DraftTopicInput[],
  options: { createTopicToken?: () => string; now?: Date } = {},
): { revision: CatalogRevision; graph: TopicGraph } {
  requireCourseId(courseId);
  const topics = materializeTopics(courseId, inputs, options.createTopicToken ?? randomUUID);
  const graph = buildTopicGraph(topics, [{
    courseId,
    title: requireCourse(db, courseId).title,
    grade: requireCourse(db, courseId).grade,
    revisionId,
  }]);
  const active = new Map(topics.map((topic, index) => [topic.id, inputs[index]?.active !== false]));

  db.transaction(() => {
    requireEditableRevision(db, courseId, revisionId, expectedEditVersion);
    const preservedRefs = db.prepare<[number], {
      topic_id: string; source_id: number; page_from: number; page_to: number;
    }>(`SELECT topic_id, source_id, page_from, page_to
          FROM revision_topic_sources WHERE revision_id = ?`).all(revisionId);
    const knownRows = db
      .prepare<[string], { id: string }>('SELECT id FROM topics WHERE course_id = ?')
      .all(courseId);
    const known = new Set(knownRows.map((row) => row.id));
    for (const topic of topics) {
      if (!known.has(topic.id)) {
        const owner = db.prepare<[string], { course_id: string }>('SELECT course_id FROM topics WHERE id = ?').get(topic.id);
        if (owner !== undefined) throw new Error(`Тема «${topic.id}» уже принадлежит другому курсу`);
        db.prepare('INSERT INTO topics (id, course_id) VALUES (?, ?)').run(topic.id, courseId);
      }
    }
    db.prepare('DELETE FROM revision_topics WHERE revision_id = ?').run(revisionId);
    const insertTopic = db.prepare(
      `INSERT INTO revision_topics
         (revision_id, topic_id, title, exam_weight, difficulty, answer_format, prompt_seed, position, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPrereq = db.prepare(
      `INSERT INTO topic_prereqs (revision_id, topic_id, prereq_topic_id, position)
       VALUES (?, ?, ?, ?)`,
    );
    topics.forEach((topic, position) => {
      insertTopic.run(
        revisionId,
        topic.id,
        topic.title,
        topic.examWeight,
        topic.difficulty,
        topic.answerFormat,
        topic.promptSeed,
        position,
        active.get(topic.id) ? 1 : 0,
      );
    });
    topics.forEach((topic) => {
      topic.prereqs.forEach((prereq, position) => insertPrereq.run(revisionId, topic.id, prereq, position));
    });
    const insertRef = db.prepare(
      `INSERT INTO revision_topic_sources
         (revision_id, topic_id, source_id, page_from, page_to)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const preservedByTopic = new Map<string, TopicSourceRef[]>();
    for (const ref of preservedRefs) {
      preservedByTopic.set(ref.topic_id, [...(preservedByTopic.get(ref.topic_id) ?? []), {
        sourceId: ref.source_id, pageFrom: ref.page_from, pageTo: ref.page_to,
      }]);
    }
    topics.forEach((topic, index) => {
      const refs = inputs[index]?.sourceRefs ?? preservedByTopic.get(topic.id) ?? [];
      for (const ref of refs) {
        if (!Number.isSafeInteger(ref.sourceId) || !Number.isSafeInteger(ref.pageFrom)
          || !Number.isSafeInteger(ref.pageTo) || ref.pageFrom < 1 || ref.pageTo < ref.pageFrom) {
          throw new Error(`Тема «${topic.id}»: некорректная ссылка на источник`);
        }
        const pages = db.prepare<[number, number, number, number, number], { count: number }>(
          `SELECT COUNT(*) AS count FROM source_pages sp
             JOIN course_sources cs ON cs.id = sp.source_id
             JOIN course_revisions cr ON cr.id = ?
            WHERE cs.id = ? AND (
              cs.revision_id = ? OR EXISTS (
                SELECT 1 FROM revision_topic_sources inherited
                 WHERE inherited.revision_id = cr.based_on_revision_id
                   AND inherited.source_id = cs.id
              )
            ) AND sp.page_number BETWEEN ? AND ?
              AND sp.status IN ('ready', 'suspicious')`,
        ).get(revisionId, ref.sourceId, revisionId, ref.pageFrom, ref.pageTo)?.count ?? 0;
        if (pages !== ref.pageTo - ref.pageFrom + 1) {
          throw new Error(`Тема «${topic.id}»: ссылка ведёт на неизвестные или неготовые страницы`);
        }
        insertRef.run(revisionId, topic.id, ref.sourceId, ref.pageFrom, ref.pageTo);
      }
    });
    const changed = db.prepare(
      `UPDATE course_revisions SET edit_version = edit_version + 1
       WHERE id = ? AND status = 'draft' AND edit_version = ?`,
    ).run(revisionId, expectedEditVersion);
    if (changed.changes !== 1) throw new CatalogConflictError(`Черновик ${revisionId} уже изменён`);
    db.prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(
      (options.now ?? new Date()).toISOString(),
      courseId,
    );
  }).immediate();
  return { revision: toRevision(selectRevision(db, revisionId) as RevisionRow), graph };
}

export function readRevisionGraph(db: Database, revisionId: number, options: { dataDir?: string } = {}): TopicGraph {
  const revision = selectRevision(db, revisionId);
  if (revision === undefined) throw new CatalogNotFoundError(`Редакция ${revisionId} не найдена`);
  const rows = db.prepare<
    [number],
    { topic_id: string; title: string; exam_weight: number; difficulty: number; answer_format: AnswerFormat; prompt_seed: string }
  >(
    `SELECT topic_id, title, exam_weight, difficulty, answer_format, prompt_seed
       FROM revision_topics WHERE revision_id = ? AND active = 1 ORDER BY position`,
  ).all(revisionId);
  const prereqs = db.prepare<[number], { topic_id: string; prereq_topic_id: string }>(
    `SELECT topic_id, prereq_topic_id FROM topic_prereqs
      WHERE revision_id = ? ORDER BY topic_id, position`,
  ).all(revisionId);
  const byTopic = new Map<string, string[]>();
  for (const row of prereqs) byTopic.set(row.topic_id, [...(byTopic.get(row.topic_id) ?? []), row.prereq_topic_id]);
  return buildTopicGraph(rows.map((row): Topic => ({
    id: row.topic_id,
    subject: revision.course_id,
    title: row.title,
    examWeight: row.exam_weight,
    difficulty: row.difficulty,
    answerFormat: row.answer_format,
    promptSeed: row.prompt_seed,
    prereqs: byTopic.get(row.topic_id) ?? [],
    courseTitle: revision.title,
    grade: revision.grade,
    sourceContext: retrieveCourseSources(db, {
      revisionId,
      topicId: row.topic_id,
      ...(options.dataDir === undefined ? { maxImages: 0 } : { dataDir: options.dataDir }),
    }),
  })), [{
    courseId: revision.course_id,
    title: revision.title,
    grade: revision.grade,
    revisionId,
  }]);
}

function validateRevisionSources(db: Database, revisionId: number): void {
  const revision = selectRevision(db, revisionId);
  if (revision === undefined) throw new CatalogNotFoundError(`Редакция ${revisionId} не найдена`);
  const sources = db.prepare<[number, number], { id: number; status: string; page_count: number | null }>(
    `SELECT DISTINCT cs.id, cs.status, cs.page_count
       FROM course_sources cs
      WHERE cs.revision_id = ?
         OR EXISTS (
           SELECT 1 FROM revision_topic_sources rts
            WHERE rts.revision_id = ? AND rts.source_id = cs.id
         )
      ORDER BY cs.id`,
  ).all(revisionId, revisionId);
  if (sources.length === 0) return; // A course authored manually may have no PDF.
  const incomplete = sources.filter((source) => source.status !== 'ready');
  if (incomplete.length > 0) {
    throw new Error(`Редакция ${revisionId}: источники не готовы: ${incomplete.map((row) => row.id).join(', ')}`);
  }
  for (const source of sources) {
    const pages = db.prepare<[number], { total: number; incomplete: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ready', 'suspicious') THEN 0 ELSE 1 END) AS incomplete
         FROM source_pages WHERE source_id = ?`,
    ).get(source.id) ?? { total: 0, incomplete: 0 };
    if (source.page_count === null || pages.total !== source.page_count || pages.incomplete > 0) {
      throw new Error(`Редакция ${revisionId}: источник ${source.id} обработан не полностью`);
    }
  }
  const topicWithoutRef = db.prepare<[number], { topic_id: string }>(
    `SELECT rt.topic_id FROM revision_topics rt
      WHERE rt.revision_id = ? AND rt.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM revision_topic_sources rts
           WHERE rts.revision_id = rt.revision_id AND rts.topic_id = rt.topic_id
        ) LIMIT 1`,
  ).get(revisionId);
  if (topicWithoutRef !== undefined) {
    throw new Error(`Редакция ${revisionId}: у темы «${topicWithoutRef.topic_id}» нет ссылки на источник`);
  }
  const invalidRef = db.prepare<[number, string], { source_id: number; page_from: number; page_to: number }>(
    `SELECT rts.source_id, rts.page_from, rts.page_to
       FROM revision_topic_sources rts
      WHERE rts.revision_id = ? AND (
        NOT EXISTS (
          SELECT 1 FROM course_sources cs
           WHERE cs.id = rts.source_id AND cs.course_id = ?
        )
        OR EXISTS (
          WITH RECURSIVE pages(page) AS (
            SELECT rts.page_from UNION ALL SELECT page + 1 FROM pages WHERE page < rts.page_to
          )
          SELECT 1 FROM pages
           WHERE NOT EXISTS (
             SELECT 1 FROM source_pages sp WHERE sp.source_id = rts.source_id AND sp.page_number = pages.page
               AND sp.status IN ('ready', 'suspicious')
           )
        )
      ) LIMIT 1`,
  ).get(revisionId, revision.course_id);
  if (invalidRef !== undefined) {
    throw new Error(`Редакция ${revisionId}: неизвестная ссылка source ${invalidRef.source_id}, pages ${invalidRef.page_from}-${invalidRef.page_to}`);
  }
}

export function publishRevision(
  db: Database,
  courseId: CourseId,
  revisionId: number,
  expectedEditVersion: number,
  options: { adminId?: string; now?: Date } = {},
): CatalogRevision {
  // Validate from persisted rows before taking the write lock; the same edit
  // version is checked again inside the transaction.
  requireEditableRevision(db, courseId, revisionId, expectedEditVersion);
  const graph = readRevisionGraph(db, revisionId);
  const publishedMetadata = graph.courses.get(courseId);
  if (publishedMetadata === undefined) throw new Error(`Редакция ${revisionId}: нет метаданных курса`);
  if (graph.order.length === 0) {
    throw new Error(`Редакция ${revisionId} не содержит активных тем`);
  }
  validateRevisionSources(db, revisionId);
  const at = (options.now ?? new Date()).toISOString();
  db.transaction(() => {
    requireEditableRevision(db, courseId, revisionId, expectedEditVersion);
    validateRevisionSources(db, revisionId);
    const published = db.prepare(
      `UPDATE course_revisions
          SET status = 'published', published_by = ?, published_at = ?
        WHERE id = ? AND status = 'draft' AND edit_version = ?`,
    ).run(options.adminId ?? null, at, revisionId, expectedEditVersion);
    if (published.changes !== 1) throw new CatalogConflictError(`Черновик ${revisionId} уже изменён`);
    db.prepare(
      `UPDATE courses
          SET title = ?, grade = ?, status = 'published', active_revision_id = ?, updated_at = ?, archived_at = NULL
        WHERE id = ?`,
    ).run(publishedMetadata.title, publishedMetadata.grade, revisionId, at, courseId);
    db.prepare(
      `UPDATE topics SET archived_at = ?
        WHERE course_id = ? AND id NOT IN
          (SELECT topic_id FROM revision_topics WHERE revision_id = ? AND active = 1)`,
    ).run(at, courseId, revisionId);
    db.prepare(
      `UPDATE topics SET archived_at = NULL
        WHERE course_id = ? AND id IN
          (SELECT topic_id FROM revision_topics WHERE revision_id = ? AND active = 1)`,
    ).run(courseId, revisionId);
  }).immediate();
  const result = toRevision(selectRevision(db, revisionId) as RevisionRow);
  invalidateCatalogCurricula(db);
  return result;
}

export function archiveCourse(db: Database, courseId: CourseId, now: Date = new Date()): CatalogCourse {
  requireCourse(db, courseId);
  db.prepare(
    `UPDATE courses SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now.toISOString(), now.toISOString(), courseId);
  const result = toCourse(requireCourse(db, courseId));
  invalidateCatalogCurricula(db);
  return result;
}

export function updateCourseMetadata(
  db: Database,
  courseId: CourseId,
  revisionId: number,
  expectedEditVersion: number,
  metadata: { title: string; grade: string },
  _now: Date = new Date(),
): CatalogRevision {
  db.transaction(() => {
    requireEditableRevision(db, courseId, revisionId, expectedEditVersion);
    db.prepare('UPDATE course_revisions SET title = ?, grade = ?, edit_version = edit_version + 1 WHERE id = ?').run(
      requireText(metadata.title, 'Название курса'),
      requireText(metadata.grade, 'Класс курса'),
      revisionId,
    );
  }).immediate();
  const result = toRevision(selectRevision(db, revisionId) as RevisionRow);
  return result;
}

export function bootstrapLegacyCourses(
  db: Database,
  curriculumDir: string = CURRICULUM_DIR,
): { created: CourseId[]; skipped: CourseId[] } {
  const graph = loadCurriculum(curriculumDir);
  const created: CourseId[] = [];
  const skipped: CourseId[] = [];
  const assignedChildren = new Set<string>();
  db.transaction(() => {
    for (const courseId of graph.subjects) {
      if (selectCourse(db, courseId) !== undefined) {
        skipped.push(courseId);
        continue;
      }
      const metadata = graph.courses.get(courseId);
      if (metadata === undefined) throw new Error(`У legacy-курса «${courseId}» нет метаданных`);
      const { draft } = createCourse(db, {
        id: courseId,
        title: metadata.title,
        grade: metadata.grade || '7 класс',
      });
      const courseTopics = graph.bySubject.get(courseId) ?? [];
      const replaced = replaceDraftTopics(
        db,
        courseId,
        draft.id,
        draft.editVersion,
        courseTopics.map((topic): DraftTopicInput => ({
          id: topic.id,
          title: topic.title,
          examWeight: topic.examWeight,
          difficulty: topic.difficulty,
          prereqs: [...topic.prereqs],
          answerFormat: topic.answerFormat,
          promptSeed: topic.promptSeed,
        })),
      );
      publishRevision(db, courseId, draft.id, replaced.revision.editVersion);
      created.push(courseId);
    }
    const children = db.prepare<[], { id: string }>('SELECT id FROM children').all();
    const assign = db.prepare(
      `INSERT INTO child_courses (child_id, course_id)
       SELECT ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM child_courses WHERE child_id = ? AND course_id = ?
        )`,
    );
    for (const child of children) {
      for (const courseId of graph.subjects) {
        if (assign.run(child.id, courseId, child.id, courseId).changes > 0) assignedChildren.add(child.id);
      }
    }
  }).immediate();
  for (const childId of assignedChildren) invalidateChildCurriculum(db, childId);
  return { created, skipped };
}
