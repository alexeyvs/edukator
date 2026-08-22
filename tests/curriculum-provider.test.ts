import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignCourse, replaceTopicExclusions, unassignCourse } from '../server/course-assignments.js';
import {
  archiveCourse,
  createCourse,
  createDraft,
  publishRevision,
  replaceDraftTopics,
  type DraftTopicInput,
} from '../server/course-catalog.js';
import { CurriculumProvider } from '../server/curriculum-provider.js';
import { openControlDatabase } from '../server/control-db.js';

let dir: string;
let db: Database;

const topic = (courseId: string, suffix: string, prereqs: string[] = []): DraftTopicInput => ({
  id: `${courseId}.${suffix}`,
  title: suffix,
  examWeight: 2,
  difficulty: 1,
  prereqs,
  answerFormat: 'text',
  promptSeed: suffix,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-provider-'));
  db = openControlDatabase(join(dir, 'control.db'));
  db.prepare("INSERT INTO parents (id, email) VALUES ('parent', 'parent@example.com')").run();
  db.prepare("INSERT INTO children (id, parent_id, name) VALUES ('abcdef01', 'parent', 'Ученик')").run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function publish(courseId: string, title: string, grade: string, topics: DraftTopicInput[]): number {
  const { draft } = createCourse(db, { id: courseId, title, grade });
  const changed = replaceDraftTopics(db, courseId, draft.id, draft.editVersion, topics);
  publishRevision(db, courseId, draft.id, changed.revision.editVersion);
  return draft.id;
}

describe('CurriculumProvider', () => {
  it('возвращает пустой immutable снимок без назначений', () => {
    const snapshot = new CurriculumProvider(db).get('abcdef01');
    expect(snapshot.courses).toEqual([]);
    expect(snapshot.graph.subjects).toEqual([]);
    expect(() => snapshot.graph.byId.set('x', {} as never)).toThrow(/неизменяем/);
    expect(() => snapshot.graph.subjects.push('science-7')).toThrow();
  });

  it('собирает курсы разных классов и удаляет исключения из графа', () => {
    publish('science-7', 'Наука', '7 класс', [
      topic('science-7', 'intro'),
      topic('science-7', 'next', ['science-7.intro']),
    ]);
    publish('history-8', 'История', '8 класс', [topic('history-8', 'intro')]);
    assignCourse(db, 'abcdef01', 'science-7', new Date('2030-01-01T00:00:00.000Z'));
    assignCourse(db, 'abcdef01', 'history-8', new Date('2030-01-02T00:00:00.000Z'));
    replaceTopicExclusions(db, 'abcdef01', 'science-7', ['science-7.intro']);

    const snapshot = new CurriculumProvider(db).get('abcdef01');
    expect(snapshot.courses.map(({ courseId, grade }) => ({ courseId, grade }))).toEqual([
      { courseId: 'science-7', grade: '7 класс' },
      { courseId: 'history-8', grade: '8 класс' },
    ]);
    expect([...snapshot.graph.byId.keys()]).toEqual(['science-7.next', 'history-8.intro']);
    expect(snapshot.graph.byId.get('science-7.next')?.prereqs).toEqual([]);
  });

  it('обновляет кеш после назначения, публикации и архивирования', () => {
    const firstRevision = publish('science-7', 'Наука', '7 класс', [topic('science-7', 'intro')]);
    const provider = new CurriculumProvider(db);
    const empty = provider.get('abcdef01');
    expect(provider.get('abcdef01')).toBe(empty);

    assignCourse(db, 'abcdef01', 'science-7');
    const assigned = provider.get('abcdef01');
    expect(assigned).not.toBe(empty);
    expect(assigned.revisionIds.get('science-7')).toBe(firstRevision);
    expect(provider.get('abcdef01')).toBe(assigned);

    const draft = createDraft(db, 'science-7', firstRevision);
    const changed = replaceDraftTopics(db, 'science-7', draft.id, draft.editVersion, [
      topic('science-7', 'intro'),
      topic('science-7', 'new'),
    ]);
    publishRevision(db, 'science-7', draft.id, changed.revision.editVersion);
    const updated = provider.get('abcdef01');
    expect(updated).not.toBe(assigned);
    expect(updated.graph.byId.has('science-7.new')).toBe(true);

    archiveCourse(db, 'science-7');
    expect(provider.get('abcdef01').courses).toEqual([]);
  });

  it('не возвращает снятый курс и не включает архивную тему новой редакции', () => {
    const firstRevision = publish('science-7', 'Наука', '7 класс', [
      topic('science-7', 'old'),
      topic('science-7', 'kept'),
    ]);
    assignCourse(db, 'abcdef01', 'science-7');
    const draft = createDraft(db, 'science-7', firstRevision);
    const changed = replaceDraftTopics(db, 'science-7', draft.id, draft.editVersion, [
      topic('science-7', 'kept'),
    ]);
    publishRevision(db, 'science-7', draft.id, changed.revision.editVersion);

    const provider = new CurriculumProvider(db);
    expect([...provider.get('abcdef01').graph.byId.keys()]).toEqual(['science-7.kept']);
    unassignCourse(db, 'abcdef01', 'science-7');
    expect(provider.get('abcdef01').graph.subjects).toEqual([]);
  });
});
