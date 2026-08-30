import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignCourse,
  assignCourseWithExclusions,
  listCourseAssignments,
  readCourseAssignment,
  replaceTopicExclusions,
  unassignCourse,
} from '../server/course-assignments.js';
import {
  bootstrapLegacyCourses,
  createCourse,
  publishRevision,
  replaceDraftTopics,
  type DraftTopicInput,
} from '../server/course-catalog.js';
import { CURRICULUM_DIR } from '../server/curriculum.js';
import { openControlDatabase } from '../server/control-db.js';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-assignments-'));
  db = openControlDatabase(join(dir, 'control.db'));
  db.prepare("INSERT INTO parents (id, email) VALUES ('parent', 'parent@example.com')").run();
  db.prepare("INSERT INTO children (id, parent_id, name) VALUES ('abcdef01', 'parent', 'Ученик')").run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function publish(courseId = 'science-7'): DraftTopicInput[] {
  const topics: DraftTopicInput[] = [
    {
      id: `${courseId}.intro`, title: 'Введение', examWeight: 2, difficulty: 1,
      prereqs: [], answerFormat: 'text', promptSeed: 'Введение',
    },
    {
      id: `${courseId}.next`, title: 'Продолжение', examWeight: 2, difficulty: 2,
      prereqs: [`${courseId}.intro`], answerFormat: 'text', promptSeed: 'Продолжение',
    },
  ];
  const { draft } = createCourse(db, { id: courseId, title: 'Наука', grade: '7 класс' });
  const changed = replaceDraftTopics(db, courseId, draft.id, draft.editVersion, topics);
  publishRevision(db, courseId, draft.id, changed.revision.editVersion);
  return topics;
}

describe('course assignments', () => {
  it('назначает курс идемпотентно и сохраняет историю снятия', () => {
    publish();
    const assigned = assignCourse(db, 'abcdef01', 'science-7', new Date('2030-01-01T10:00:00.000Z'));
    expect(assigned).toMatchObject({ courseId: 'science-7', unassignedAt: null });
    expect(assignCourse(db, 'abcdef01', 'science-7', new Date('2030-01-01T11:00:00.000Z')).assignedAt)
      .toBe('2030-01-01T10:00:00.000Z');

    expect(unassignCourse(db, 'abcdef01', 'science-7', new Date('2030-01-02T10:00:00.000Z')))
      .toMatchObject({ unassignedAt: '2030-01-02T10:00:00.000Z' });
    expect(listCourseAssignments(db, 'abcdef01')).toEqual([]);
    expect(listCourseAssignments(db, 'abcdef01', { includeUnassigned: true })).toHaveLength(1);

    expect(assignCourse(db, 'abcdef01', 'science-7', new Date('2030-01-03T10:00:00.000Z')))
      .toMatchObject({ assignedAt: '2030-01-03T10:00:00.000Z', unassignedAt: null });
    expect(listCourseAssignments(db, 'abcdef01', { includeUnassigned: true })).toHaveLength(2);
  });

  it('заменяет набор исключений атомарно и проверяет принадлежность тем', () => {
    publish();
    assignCourse(db, 'abcdef01', 'science-7');
    expect(replaceTopicExclusions(db, 'abcdef01', 'science-7', ['science-7.intro']))
      .toMatchObject({ excludedTopicIds: ['science-7.intro'] });
    expect(() => replaceTopicExclusions(db, 'abcdef01', 'science-7', ['science-7.missing']))
      .toThrow(/не принадлежит/);
    expect(readCourseAssignment(db, 'abcdef01', 'science-7')?.excludedTopicIds)
      .toEqual(['science-7.intro']);
    expect(replaceTopicExclusions(db, 'abcdef01', 'science-7', [])?.excludedTopicIds).toEqual([]);
  });

  it('не оставляет назначение, если исключения не удалось сохранить', () => {
    publish();
    expect(() => assignCourseWithExclusions(
      db, 'abcdef01', 'science-7', ['science-7.intro', 'science-7.missing'],
    )).toThrow(/не принадлежит/u);
    expect(readCourseAssignment(db, 'abcdef01', 'science-7')).toBeUndefined();
  });

  it('повторное заведение legacy-курсов не восстанавливает снятый родителем', () => {
    bootstrapLegacyCourses(db, CURRICULUM_DIR);
    // Заведение курсов больше не назначает их — назначает родитель, явно.
    for (const courseId of ['english', 'math', 'russian'] as const) {
      assignCourseWithExclusions(db, 'abcdef01', courseId, [], new Date('2030-01-01T00:00:00.000Z'));
    }
    expect(listCourseAssignments(db, 'abcdef01').map((item) => item.courseId).sort())
      .toEqual(['english', 'math', 'russian']);
    unassignCourse(db, 'abcdef01', 'math', new Date('2030-01-01T00:00:00.000Z'));

    bootstrapLegacyCourses(db, CURRICULUM_DIR);
    expect(listCourseAssignments(db, 'abcdef01').map((item) => item.courseId).sort())
      .toEqual(['english', 'russian']);
    expect(readCourseAssignment(db, 'abcdef01', 'math')?.unassignedAt).not.toBeNull();
  });

  it('откатывает замену исключений целиком при ошибке', () => {
    publish();
    assignCourse(db, 'abcdef01', 'science-7');
    replaceTopicExclusions(db, 'abcdef01', 'science-7', ['science-7.intro']);
    expect(() => replaceTopicExclusions(
      db,
      'abcdef01',
      'science-7',
      ['science-7.next', 'other.topic'],
    )).toThrow();
    expect(readCourseAssignment(db, 'abcdef01', 'science-7')?.excludedTopicIds)
      .toEqual(['science-7.intro']);
  });
});
