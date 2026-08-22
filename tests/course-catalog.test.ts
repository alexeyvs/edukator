import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogConflictError,
  PublishedRevisionError,
  archiveCourse,
  bootstrapLegacyCourses,
  createCourse,
  createDraft,
  listCourses,
  publishRevision,
  readCourse,
  readRevision,
  readRevisionGraph,
  replaceDraftTopics,
  updateCourseMetadata,
  type DraftTopicInput,
} from '../server/course-catalog.js';
import { CURRICULUM_DIR } from '../server/curriculum.js';
import { openControlDatabase } from '../server/control-db.js';

let dir: string;
let db: Database;

const topic = (overrides: Partial<DraftTopicInput> = {}): DraftTopicInput => ({
  id: 'science-7.intro',
  title: 'Введение',
  examWeight: 2,
  difficulty: 1,
  prereqs: [],
  answerFormat: 'text',
  promptSeed: 'Проверяй основные понятия.',
  ...overrides,
});

const generatedTopic = (
  overrides: Partial<Omit<DraftTopicInput, 'id'>> = {},
): DraftTopicInput => {
  const base = topic();
  delete base.id;
  return { ...base, ...overrides };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-catalog-'));
  db = openControlDatabase(join(dir, 'control.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function createScience(): ReturnType<typeof createCourse> {
  return createCourse(db, { id: 'science-7', title: 'Естествознание', grade: '7 класс' });
}

describe('course catalog CRUD', () => {
  it('создаёт курс с единственным черновиком и читает его', () => {
    const created = createScience();

    expect(created.course).toMatchObject({
      id: 'science-7',
      title: 'Естествознание',
      grade: '7 класс',
      status: 'draft',
      activeRevisionId: null,
    });
    expect(created.draft).toMatchObject({ revisionNumber: 1, status: 'draft', editVersion: 1 });
    expect(listCourses(db)).toHaveLength(1);
    expect(() => createScience()).toThrow(CatalogConflictError);
  });

  it('назначает новым темам стабильные ID и сохраняет валидный граф', () => {
    const { draft } = createScience();
    let token = 0;
    const result = replaceDraftTopics(
      db,
      'science-7',
      draft.id,
      1,
      [
        generatedTopic({ clientId: 'intro' }),
        generatedTopic({
          clientId: 'advanced',
          title: 'Продолжение',
          prereqs: ['intro'],
        }),
      ],
      { createTopicToken: () => `topic-${++token}` },
    );

    expect(result.revision.editVersion).toBe(2);
    expect([...result.graph.byId.keys()]).toEqual([
      'science-7.topic-1',
      'science-7.topic-2',
    ]);
    expect(readRevisionGraph(db, draft.id).byId.get('science-7.topic-2')?.prereqs).toEqual([
      'science-7.topic-1',
    ]);
  });

  it('отвергает устаревшую optimistic-версию и оставляет данные прежними', () => {
    const { draft } = createScience();
    const changed = replaceDraftTopics(db, 'science-7', draft.id, 1, [topic()]);

    expect(() =>
      replaceDraftTopics(db, 'science-7', draft.id, 1, [topic({ title: 'Затёрто' })]),
    ).toThrow(CatalogConflictError);
    expect(readRevisionGraph(db, draft.id).byId.get('science-7.intro')?.title).toBe('Введение');
    expect(changed.revision.editVersion).toBe(2);
  });

  it('проверяет неизвестные зависимости, циклы и namespace до записи', () => {
    const { draft } = createScience();
    expect(() =>
      replaceDraftTopics(db, 'science-7', draft.id, 1, [topic({ prereqs: ['science-7.missing'] })]),
    ).toThrow(/несуществующую тему/);
    expect(() =>
      replaceDraftTopics(db, 'science-7', draft.id, 1, [
        topic({ prereqs: ['science-7.two'] }),
        topic({ id: 'science-7.two', prereqs: ['science-7.intro'] }),
      ]),
    ).toThrow(/цикл/);
    expect(() =>
      replaceDraftTopics(db, 'science-7', draft.id, 1, [topic({ id: 'other.intro' })]),
    ).toThrow(/не принадлежит/);
    expect(readRevisionGraph(db, draft.id).subjects).toEqual([]);
  });

  it('публикует атомарно, клонирует следующую редакцию и запрещает править опубликованную', () => {
    const { draft } = createScience();
    const changed = replaceDraftTopics(db, 'science-7', draft.id, 1, [topic()]);
    const published = publishRevision(db, 'science-7', draft.id, changed.revision.editVersion);

    expect(published.status).toBe('published');
    expect(readCourse(db, 'science-7')).toMatchObject({
      status: 'published',
      activeRevisionId: draft.id,
    });
    expect(() => replaceDraftTopics(db, 'science-7', draft.id, 2, [topic()])).toThrow(
      PublishedRevisionError,
    );
    expect(() => updateCourseMetadata(db, 'science-7', draft.id, 2, { title: 'X', grade: '8' })).toThrow(
      PublishedRevisionError,
    );

    const next = createDraft(db, 'science-7', draft.id);
    expect(next).toMatchObject({ revisionNumber: 2, basedOnRevisionId: draft.id, status: 'draft' });
    expect(readRevisionGraph(db, next.id).byId.get('science-7.intro')?.title).toBe('Введение');
    expect(() => createDraft(db, 'science-7', draft.id)).toThrow(/уже есть черновик/);
  });

  it('не публикует пустой черновик', () => {
    const { draft } = createScience();
    expect(() => publishRevision(db, 'science-7', draft.id, 1)).toThrow(/не содержит активных тем/);
    expect(readRevision(db, draft.id)?.status).toBe('draft');
  });

  it('откатывает всю публикацию, если переключение курса падает', () => {
    const { draft } = createScience();
    const changed = replaceDraftTopics(db, 'science-7', draft.id, 1, [topic()]);
    db.exec(`
      CREATE TRIGGER reject_course_publication
      BEFORE UPDATE OF active_revision_id ON courses
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END;
    `);

    expect(() => publishRevision(db, 'science-7', draft.id, changed.revision.editVersion)).toThrow(
      /test rollback/,
    );
    expect(readRevision(db, draft.id)?.status).toBe('draft');
    expect(readCourse(db, 'science-7')).toMatchObject({ status: 'draft', activeRevisionId: null });
  });

  it('архивирует вместо удаления', () => {
    createScience();
    expect(archiveCourse(db, 'science-7')).toMatchObject({ status: 'archived' });
    expect(() => createDraft(db, 'science-7', 1)).toThrow(/архивирован/);
  });
});

describe('legacy bootstrap', () => {
  it('импортирует три карты с исходными ID и повторяется без дублей', () => {
    const first = bootstrapLegacyCourses(db, CURRICULUM_DIR);
    expect(first).toEqual({ created: ['math', 'russian', 'english'], skipped: [] });
    expect(listCourses(db).map((course) => course.id).sort()).toEqual(['english', 'math', 'russian']);
    expect(readRevisionGraph(db, readCourse(db, 'math')?.activeRevisionId as number).byId.has(
      'math.natural-number-operations',
    )).toBe(true);

    const second = bootstrapLegacyCourses(db, CURRICULUM_DIR);
    expect(second).toEqual({ created: [], skipped: ['math', 'russian', 'english'] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM course_revisions').get()).toEqual({ count: 3 });
  });
});
