import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCourse, replaceDraftTopics } from '../server/course-catalog.js';
import { indexSourcePage, retrieveCourseSources } from '../server/course-retrieval.js';
import { openControlDatabase } from '../server/control-db.js';

describe('course source retrieval', () => {
  let dir: string;
  let db: Database;
  let revisionId: number;
  let sourceId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-retrieval-'));
    db = openControlDatabase(join(dir, 'control.db'));
    const draft = createCourse(db, { id: 'biology-6', title: 'Биология', grade: '6 класс' }).draft;
    revisionId = draft.id;
    const changed = replaceDraftTopics(db, 'biology-6', revisionId, 1, [{ id: 'biology-6.cell', title: 'Клетка', examWeight: 2,
      difficulty: 1, prereqs: [], answerFormat: 'text', promptSeed: 'Строение клетки' }]);
    expect(changed.graph.order).toHaveLength(1);
    sourceId = Number(db.prepare(`INSERT INTO course_sources
      (course_id, revision_id, upload_name, sha256, artifact_path, page_count, status)
      VALUES ('biology-6', ?, 'book.pdf', ?, 'catalog/book.pdf', 2, 'ready')`)
      .run(revisionId, 'a'.repeat(64)).lastInsertRowid);
    db.prepare(`INSERT INTO source_pages (source_id, page_number, status, text, image_path)
      VALUES (?, 1, 'ready', 'Клеточная мембрана защищает клетку', 'catalog/page-1.jpg'),
             (?, 2, 'ready', 'Ядро хранит наследственную информацию', 'catalog/page-2.jpg')`).run(sourceId, sourceId);
    indexSourcePage(db, sourceId, 1, 'Клеточная мембрана защищает клетку');
    indexSourcePage(db, sourceId, 2, 'Ядро хранит наследственную информацию');
    db.prepare(`INSERT INTO revision_topic_sources (revision_id, topic_id, source_id, page_from, page_to)
      VALUES (?, 'biology-6.cell', ?, 1, 2)`).run(revisionId, sourceId);
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('ищет по FTS и topic refs с жёсткими пределами фрагментов и картинок', () => {
    const result = retrieveCourseSources(db, { revisionId, topicId: 'biology-6.cell', query: 'мембрана', dataDir: dir,
      maxFragments: 1, maxImages: 1 });
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({ sourceId, pageNumber: 1 });
    expect(result.images).toEqual([join(dir, 'catalog/page-1.jpg')]);
    expect(() => retrieveCourseSources(db, { revisionId, maxFragments: 17 })).toThrow(/0\.\.16/u);
  });

  it('переиндексирует страницу без старого текста', () => {
    indexSourcePage(db, sourceId, 1, 'Только цитоплазма');
    expect(retrieveCourseSources(db, { revisionId, query: 'мембрана' }).fragments).toEqual([]);
    expect(retrieveCourseSources(db, { revisionId, query: 'цитоплазма' }).fragments).toHaveLength(1);
  });
});
