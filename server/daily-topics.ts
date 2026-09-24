/** Родительский список школьных тем на московский день. */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { TopicGraph } from './curriculum.js';
import { moscowDate } from './moscow-time.js';

export interface DailyTopicInput {
  title: string;
  subjectId: string | null;
  subjectTitle: string;
  topicId: string | null;
}

export interface DailyTopicItem {
  id: number;
  position: number;
  topicId: string;
  subject: string;
  subjectTitle: string;
  courseRevisionId: number | null;
  title: string;
  materialId: number | null;
  status: 'preparing' | 'ready' | 'error';
  materialStatus: string | null;
  lastError: string | null;
  firstScore: number | null;
  firstTotal: number | null;
  firstRunId: number | null;
}

export interface DailyTopicSet {
  id: number;
  day: string;
  status: 'preparing' | 'active' | 'cancelled';
  sourceText: string;
  items: DailyTopicItem[];
}

interface SetRow {
  id: number;
  day: string;
  status: DailyTopicSet['status'];
  source_text: string;
}

interface ItemRow {
  id: number;
  position: number;
  topic_id: string;
  subject: string;
  subject_title: string | null;
  course_revision_id: number | null;
  title: string;
  material_id: number | null;
  status: DailyTopicItem['status'];
  material_status: string | null;
  last_error: string | null;
  first_score: number | null;
  first_total: number | null;
  first_run_id: number | null;
}

export class DailyTopicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyTopicError';
  }
}

function clean(value: string, label: string, max = 500): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new DailyTopicError(`${label}: требуется от 1 до ${max} символов`);
  }
  return trimmed;
}

function readSet(db: Database, id: number): DailyTopicSet {
  const row = db.prepare<[number], SetRow>(
    'SELECT id, day, status, source_text FROM daily_topic_sets WHERE id = ?',
  ).get(id);
  if (row === undefined) throw new DailyTopicError('Дневное назначение не найдено');
  const items = db.prepare<[number], ItemRow>(
    `SELECT dti.id, dti.position, dti.topic_id, dti.subject, pc.title AS subject_title, dti.title,
            dti.course_revision_id,
            dti.material_id, dti.status, dti.last_error,
            lm.status AS material_status,
            first_run.correct AS first_score, first_run.total AS first_total,
            first_run.id AS first_run_id
       FROM daily_topic_items dti
       LEFT JOIN personal_courses pc ON pc.id = dti.subject
       LEFT JOIN learning_materials lm ON lm.id = dti.material_id
       LEFT JOIN learning_runs first_learning
         ON first_learning.material_id = lm.id AND first_learning.attempt_number = 1
       LEFT JOIN runs first_run ON first_run.id = first_learning.run_id
         AND first_run.finished_at IS NOT NULL AND first_run.summary IS NOT NULL
      WHERE dti.set_id = ? ORDER BY dti.position`,
  ).all(id);
  return {
    id: row.id,
    day: row.day,
    status: row.status,
    sourceText: row.source_text,
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      topicId: item.topic_id,
      subject: item.subject,
      subjectTitle: item.subject_title ?? item.subject,
      courseRevisionId: item.course_revision_id,
      title: item.title,
      materialId: item.material_id,
      status: item.status,
      materialStatus: item.material_status,
      lastError: item.last_error,
      firstScore: item.first_score,
      firstTotal: item.first_total,
      firstRunId: item.first_run_id,
    })),
  };
}

export function dailyTopicSets(db: Database, at: Date = new Date()): {
  active: DailyTopicSet | null;
  preparing: DailyTopicSet | null;
} {
  const rows = db.prepare<[string], { id: number; status: string }>(
    `SELECT id, status FROM daily_topic_sets
      WHERE (day = ? AND status = 'active') OR status = 'preparing'
      ORDER BY id DESC`,
  ).all(moscowDate(at));
  const active = rows.find((row) => row.status === 'active');
  const preparing = rows.find((row) => row.status === 'preparing');
  return {
    active: active === undefined ? null : readSet(db, active.id),
    preparing: preparing === undefined ? null : readSet(db, preparing.id),
  };
}

export function activeDailyTopicSet(db: Database, at: Date = new Date()): DailyTopicSet | null {
  const row = db.prepare<[string], { id: number }>(
    "SELECT id FROM daily_topic_sets WHERE day = ? AND status = 'active' LIMIT 1",
  ).get(moscowDate(at));
  return row === undefined ? null : readSet(db, row.id);
}

function existingPersonalSubject(db: Database, title: string): string | undefined {
  const rows = db.prepare<[], { id: string; title: string }>(
    'SELECT id, title FROM personal_courses ORDER BY created_at, id',
  ).all();
  return rows.find((row) => row.title.toLocaleLowerCase('ru-RU') === title.toLocaleLowerCase('ru-RU'))?.id;
}

function existingPersonalTopic(db: Database, subject: string, title: string): string | undefined {
  const rows = db.prepare<[string], { id: string; title: string }>(
    'SELECT id, title FROM personal_topics WHERE subject = ? AND active = 1',
  ).all(subject);
  return rows.find((row) => row.title.toLocaleLowerCase('ru-RU') === title.toLocaleLowerCase('ru-RU'))?.id;
}

export function confirmDailyTopics(
  db: Database,
  graph: TopicGraph,
  request: { sourceText: string; requestKey: string; items: readonly DailyTopicInput[] },
  at: Date = new Date(),
): DailyTopicSet {
  const sourceText = clean(request.sourceText, 'Текст тем', 65_536);
  const requestKey = clean(request.requestKey, 'Ключ запроса', 120);
  if (request.items.length === 0) throw new DailyTopicError('Нужно указать хотя бы одну тему');
  return db.transaction((): DailyTopicSet => {
    const existing = db.prepare<[string], { id: number }>(
      'SELECT id FROM daily_topic_sets WHERE request_key = ?',
    ).get(requestKey);
    if (existing !== undefined) return readSet(db, existing.id);
    const day = moscowDate(at);
    db.prepare<[string]>(
      `UPDATE daily_topic_sets SET status = 'cancelled', cancelled_at = ?
        WHERE status = 'preparing'`,
    ).run(at.toISOString());
    const inserted = db.prepare(
      `INSERT INTO daily_topic_sets (day, source_text, request_key, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(day, sourceText, requestKey, at.toISOString());
    const setId = Number(inserted.lastInsertRowid);
    const personalSubjects = new Map<string, string>();
    for (const [index, input] of request.items.entries()) {
      const title = clean(input.title, 'Тема');
      const subjectTitle = clean(input.subjectTitle, 'Предмет', 120);
      let subject = input.subjectId;
      if (subject !== null) {
        if (!graph.courses.has(subject)) throw new DailyTopicError(`Предмет «${subject}» не назначен ребёнку`);
      } else {
        const key = subjectTitle.toLocaleLowerCase('ru-RU');
        subject = personalSubjects.get(key) ?? existingPersonalSubject(db, subjectTitle) ??
          `personal-${randomUUID()}`;
        personalSubjects.set(key, subject);
        db.prepare(
          `INSERT OR IGNORE INTO personal_courses (id, title, created_at) VALUES (?, ?, ?)`,
        ).run(subject, subjectTitle, at.toISOString());
      }
      let topicId = input.topicId;
      if (topicId !== null) {
        const matched = graph.byId.get(topicId);
        if (matched?.subject !== subject) throw new DailyTopicError(`Тема «${topicId}» не относится к предмету`);
      } else {
        topicId = existingPersonalTopic(db, subject, title) ?? `personal-${randomUUID()}`;
        const course = graph.courses.get(subject);
        db.prepare(
          `INSERT OR IGNORE INTO personal_courses (id, title, grade, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(subject, course?.title ?? subjectTitle, course?.grade ?? '', at.toISOString());
        db.prepare(
          `INSERT OR IGNORE INTO personal_topics
             (id, subject, title, prompt_seed, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(topicId, subject, title, title, at.toISOString());
        db.prepare('INSERT OR IGNORE INTO topic_state (topic_id) VALUES (?)').run(topicId);
      }
      const revision = graph.courses.get(subject)?.revisionId ?? null;
      const previous = db.prepare<[string, string, string, number | null], { material_id: number; status: string }>(
        `SELECT dti.material_id, dti.status FROM daily_topic_items dti
          JOIN daily_topic_sets dts ON dts.id = dti.set_id
          JOIN learning_materials lm ON lm.id = dti.material_id
         WHERE dts.day = ? AND dts.status = 'active' AND dti.topic_id = ?
           AND dti.title = ? AND dti.course_revision_id IS ?
           AND dti.status = 'ready' AND lm.status IN ('ready', 'active', 'passed')
         ORDER BY dti.id DESC LIMIT 1`,
      ).get(day, topicId, title, revision);
      db.prepare(
        `INSERT INTO daily_topic_items
           (set_id, position, topic_id, subject, title, course_revision_id, status, material_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        setId, index + 1, topicId, subject, title,
        revision,
        previous === undefined ? 'preparing' : previous.status,
        previous?.material_id ?? null,
      );
    }
    return readSet(db, setId);
  }).immediate();
}

export function cancelDailyTopics(db: Database, at: Date = new Date()): void {
  db.prepare<[string, string]>(
    `UPDATE daily_topic_sets SET status = 'cancelled', cancelled_at = ?
      WHERE (day = ? AND status = 'active') OR status = 'preparing'`,
  ).run(at.toISOString(), moscowDate(at));
}

/** Переключение происходит только после полной публикации каждого пункта. */
export function activateDailyTopicSet(db: Database, setId: number, at: Date = new Date()): boolean {
  return db.transaction((): boolean => {
    const set = readSet(db, setId);
    if (set.status !== 'preparing' || set.items.length === 0) return false;
    if (set.items.some((item) => item.status !== 'ready' || item.materialId === null ||
      !['ready', 'active', 'passed'].includes(item.materialStatus ?? ''))) return false;
    const mismatch = db.prepare<[number], { id: number }>(
      `SELECT dti.id FROM daily_topic_items dti
         JOIN learning_materials lm ON lm.id = dti.material_id
        WHERE dti.set_id = ? AND (lm.topic_id <> dti.topic_id OR lm.subject <> dti.subject
          OR lm.course_revision_id IS NOT dti.course_revision_id) LIMIT 1`,
    ).get(setId);
    if (mismatch !== undefined) return false;
    db.prepare<[string, string]>(
      `UPDATE daily_topic_sets SET status = 'cancelled', cancelled_at = ?
        WHERE day = ? AND status = 'active'`,
    ).run(at.toISOString(), moscowDate(at));
    db.prepare<[string, string, number]>(
      `UPDATE daily_topic_sets SET status = 'active', day = ?, activated_at = ?
        WHERE id = ? AND status = 'preparing'`,
    ).run(moscowDate(at), at.toISOString(), setId);
    db.prepare<[number]>(
      `UPDATE personal_topics SET active = 1
        WHERE id IN (SELECT topic_id FROM daily_topic_items WHERE set_id = ?)`,
    ).run(setId);
    return true;
  }).immediate();
}

export function dailyMaterialAllowed(db: Database, materialId: number, at: Date = new Date()): boolean {
  const active = activeDailyTopicSet(db, at);
  if (active === null) {
    return db.prepare<[number], { daily_item_id: number | null }>(
      'SELECT daily_item_id FROM learning_materials WHERE id = ?',
    ).get(materialId)?.daily_item_id === null;
  }
  return active.items.some((item) => item.materialId === materialId);
}

export function dailyRunAllowed(db: Database, runId: number, at: Date = new Date()): boolean {
  const active = activeDailyTopicSet(db, at);
  if (active === null) return true;
  const row = db.prepare<[number], { kind: string; material_id: number | null }>(
    `SELECT runs.kind, learning_runs.material_id FROM runs
       LEFT JOIN learning_runs ON learning_runs.run_id = runs.id WHERE runs.id = ?`,
  ).get(runId);
  return row?.kind === 'lesson' && row.material_id !== null &&
    active.items.some((item) => item.materialId === row.material_id);
}
