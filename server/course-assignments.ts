import type { Database } from 'better-sqlite3';
import { requireCourseId, type CourseId } from './db.js';
import { invalidateChildCurriculum } from './curriculum-generation.js';

export interface CourseAssignment {
  id: number;
  childId: string;
  courseId: CourseId;
  assignedAt: string;
  unassignedAt: string | null;
  excludedTopicIds: readonly string[];
}

interface AssignmentRow {
  id: number;
  child_id: string;
  course_id: string;
  assigned_at: string;
  unassigned_at: string | null;
}

function requireChild(db: Database, childId: string): void {
  if (db.prepare<[string], { found: number }>('SELECT 1 AS found FROM children WHERE id = ?').get(childId) === undefined) {
    throw new Error(`Ребёнка ${childId} нет в управляющей базе`);
  }
}

function requireCourse(db: Database, courseId: CourseId): void {
  if (db.prepare<[string], { found: number }>('SELECT 1 AS found FROM courses WHERE id = ?').get(courseId) === undefined) {
    throw new Error(`Курс «${courseId}» не найден`);
  }
}

function toAssignment(db: Database, row: AssignmentRow): CourseAssignment {
  const excludedTopicIds = db
    .prepare<[string, string], { topic_id: string }>(
      `SELECT topic_id FROM child_topic_exclusions
        WHERE child_id = ? AND course_id = ? ORDER BY topic_id`,
    )
    .all(row.child_id, row.course_id)
    .map((item) => item.topic_id);
  return Object.freeze({
    childId: row.child_id,
    id: row.id,
    courseId: row.course_id,
    assignedAt: row.assigned_at,
    unassignedAt: row.unassigned_at,
    excludedTopicIds: Object.freeze(excludedTopicIds),
  });
}

export function listCourseAssignments(
  db: Database,
  childId: string,
  options: { includeUnassigned?: boolean } = {},
): readonly CourseAssignment[] {
  requireChild(db, childId);
  const rows = db
    .prepare<[string], AssignmentRow>(
      `SELECT id, child_id, course_id, assigned_at, unassigned_at
         FROM child_courses
        WHERE child_id = ?${options.includeUnassigned === true ? '' : ' AND unassigned_at IS NULL'}
        ORDER BY assigned_at, course_id`,
    )
    .all(childId);
  return Object.freeze(rows.map((row) => toAssignment(db, row)));
}

export function assignCourse(
  db: Database,
  childId: string,
  courseId: CourseId,
  now: Date = new Date(),
): CourseAssignment {
  requireCourseId(courseId);
  const stamp = now.toISOString();
  const changed = db.transaction(() => {
    requireChild(db, childId);
    requireCourse(db, courseId);
    const active = db.prepare<[string, string], { found: number }>(
      `SELECT 1 AS found FROM child_courses
        WHERE child_id = ? AND course_id = ? AND unassigned_at IS NULL`,
    ).get(childId, courseId);
    if (active !== undefined) return 0;
    return db.prepare(
      `INSERT INTO child_courses (child_id, course_id, assigned_at)
       VALUES (?, ?, ?)`,
    ).run(childId, courseId, stamp).changes;
  }).immediate();
  if (changed > 0) invalidateChildCurriculum(db, childId);
  return readCourseAssignment(db, childId, courseId) as CourseAssignment;
}

/** Assigns a course and replaces its exclusions as one externally visible mutation. */
export function assignCourseWithExclusions(
  db: Database,
  childId: string,
  courseId: CourseId,
  topicIds: readonly string[] | undefined,
  now: Date = new Date(),
): CourseAssignment {
  requireCourseId(courseId);
  const stamp = now.toISOString();
  db.transaction(() => {
    requireChild(db, childId);
    requireCourse(db, courseId);
    const active = db.prepare<[string, string], { found: number }>(
      `SELECT 1 AS found FROM child_courses
        WHERE child_id = ? AND course_id = ? AND unassigned_at IS NULL`,
    ).get(childId, courseId);
    if (active === undefined) {
      db.prepare('INSERT INTO child_courses (child_id, course_id, assigned_at) VALUES (?, ?, ?)')
        .run(childId, courseId, stamp);
    }
    if (topicIds !== undefined) {
      if (new Set(topicIds).size !== topicIds.length) throw new Error('Список исключений содержит дубли');
      const topicExists = db.prepare<[string, string], { found: number }>(
        'SELECT 1 AS found FROM topics WHERE course_id = ? AND id = ?',
      );
      for (const topicId of topicIds) {
        if (topicExists.get(courseId, topicId) === undefined) {
          throw new Error(`Тема «${topicId}» не принадлежит курсу «${courseId}»`);
        }
      }
      db.prepare('DELETE FROM child_topic_exclusions WHERE child_id = ? AND course_id = ?')
        .run(childId, courseId);
      const insert = db.prepare(
        `INSERT INTO child_topic_exclusions (child_id, course_id, topic_id, excluded_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const topicId of topicIds) insert.run(childId, courseId, topicId, stamp);
    }
    invalidateChildCurriculum(db, childId);
  }).immediate();
  return readCourseAssignment(db, childId, courseId) as CourseAssignment;
}

export function unassignCourse(
  db: Database,
  childId: string,
  courseId: CourseId,
  now: Date = new Date(),
): CourseAssignment | undefined {
  requireCourseId(courseId);
  const changed = db.transaction(() => {
    requireChild(db, childId);
    return db.prepare(
      `UPDATE child_courses SET unassigned_at = ?
        WHERE child_id = ? AND course_id = ? AND unassigned_at IS NULL`,
    ).run(now.toISOString(), childId, courseId).changes;
  }).immediate();
  if (changed > 0) invalidateChildCurriculum(db, childId);
  return readCourseAssignment(db, childId, courseId);
}

export function replaceTopicExclusions(
  db: Database,
  childId: string,
  courseId: CourseId,
  topicIds: readonly string[],
  now: Date = new Date(),
): CourseAssignment {
  requireCourseId(courseId);
  if (new Set(topicIds).size !== topicIds.length) throw new Error('Список исключений содержит дубли');
  db.transaction(() => {
    const assignment = readCourseAssignment(db, childId, courseId);
    if (assignment === undefined || assignment.unassignedAt !== null) {
      throw new Error(`Курс «${courseId}» не назначен ребёнку ${childId}`);
    }
    const topicExists = db.prepare<[string, string], { found: number }>(
      'SELECT 1 AS found FROM topics WHERE course_id = ? AND id = ?',
    );
    for (const topicId of topicIds) {
      if (topicExists.get(courseId, topicId) === undefined) {
        throw new Error(`Тема «${topicId}» не принадлежит курсу «${courseId}»`);
      }
    }
    db.prepare('DELETE FROM child_topic_exclusions WHERE child_id = ? AND course_id = ?').run(
      childId,
      courseId,
    );
    const insert = db.prepare(
      `INSERT INTO child_topic_exclusions (child_id, course_id, topic_id, excluded_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const topicId of topicIds) insert.run(childId, courseId, topicId, now.toISOString());
  }).immediate();
  invalidateChildCurriculum(db, childId);
  return readCourseAssignment(db, childId, courseId) as CourseAssignment;
}

export function readCourseAssignment(
  db: Database,
  childId: string,
  courseId: CourseId,
): CourseAssignment | undefined {
  const row = db
    .prepare<[string, string], AssignmentRow>(
      `SELECT id, child_id, course_id, assigned_at, unassigned_at
         FROM child_courses WHERE child_id = ? AND course_id = ?
        ORDER BY (unassigned_at IS NULL) DESC, assigned_at DESC, id DESC LIMIT 1`,
    )
    .get(childId, courseId);
  return row === undefined ? undefined : toAssignment(db, row);
}
