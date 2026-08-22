import { Readable } from 'node:stream';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactValidationError,
  CATALOG_ARTIFACTS_DIR,
  CATALOG_TEMP_DIR,
  CourseArtifactStore,
  resolveCatalogPath,
} from '../server/course-artifacts.js';
import {
  createCourse,
  publishRevision,
  replaceDraftTopics,
} from '../server/course-catalog.js';
import { openControlDatabase } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';

const PDF = Buffer.from('%PDF-1.7\nsmall test document\n%%EOF\n');

describe('безопасное хранилище PDF курса', () => {
  let dir: string;
  let db: Database;
  let draftId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-artifacts-'));
    ensureDataDir(dir);
    db = openControlDatabase(controlDatabasePath(dir));
    draftId = createCourse(db, { id: 'physics-8', title: 'Физика', grade: '8 класс' }).draft.id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function store(options: ConstructorParameters<typeof CourseArtifactStore>[2] = {}) {
    return new CourseArtifactStore(db, dir, {
      inspector: { inspect: async () => ({ pageCount: 3 }) },
      ...options,
    });
  }

  it('пишет через серверный путь, считает hash/pages и дедуплицирует содержимое', async () => {
    const artifacts = store();
    const first = await artifacts.upload(
      'physics-8', draftId, '../../private\\book.pdf', Readable.from(PDF),
    );
    expect(first.duplicate).toBe(false);
    expect(first.source).toMatchObject({
      uploadName: 'book.pdf',
      pageCount: 3,
      status: 'uploaded',
    });
    const row = db.prepare<[number], { artifact_path: string }>(
      'SELECT artifact_path FROM course_sources WHERE id = ?',
    ).get(first.source.id);
    expect(row?.artifact_path).toMatch(
      new RegExp(`^${CATALOG_ARTIFACTS_DIR}/physics-8/${draftId}/[a-f0-9]{64}\\.pdf$`, 'u'),
    );
    expect(existsSync(resolveCatalogPath(dir, row?.artifact_path ?? 'missing'))).toBe(true);

    const duplicate = await artifacts.upload(
      'physics-8', draftId, 'another-name.pdf', Readable.from(PDF),
    );
    expect(duplicate).toMatchObject({ duplicate: true, source: { id: first.source.id } });
    expect(artifacts.list('physics-8')).toHaveLength(1);
  });

  it('отвергает поддельную сигнатуру, превышение размера и числа страниц', async () => {
    await expect(store().upload(
      'physics-8', draftId, 'fake.pdf', Readable.from(Buffer.from('not a pdf')),
    )).rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(store({ maxBytes: 8 }).upload(
      'physics-8', draftId, 'large.pdf', Readable.from(PDF),
    )).rejects.toThrow(/превышает предел/u);
    await expect(store({
      maxPages: 2,
      inspector: { inspect: async () => ({ pageCount: 3 }) },
    }).upload('physics-8', draftId, 'pages.pdf', Readable.from(PDF))).rejects.toThrow(/больше 2 страниц/u);
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM course_sources').get()?.count)
      .toBe(0);
  });

  it('не допускает path traversal в сохранённых путях', () => {
    expect(() => resolveCatalogPath(dir, '../control.db')).toThrow(/выходит/u);
    expect(() => resolveCatalogPath(dir, '/etc/passwd')).toThrow(/Некорректный/u);
    expect(() => resolveCatalogPath(dir, 'catalog\\..\\control.db')).toThrow(/Некорректный/u);
  });

  it('при сбое до commit удаляет temp и не оставляет строки или артефакта', async () => {
    const artifacts = store({ beforeCommit: () => { throw new Error('disk fault'); } });
    await expect(artifacts.upload(
      'physics-8', draftId, 'book.pdf', Readable.from(PDF),
    )).rejects.toThrow('disk fault');
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM course_sources').get()?.count)
      .toBe(0);
    expect(existsSync(resolveCatalogPath(dir, CATALOG_ARTIFACTS_DIR))).toBe(false);
    const temp = resolveCatalogPath(dir, CATALOG_TEMP_DIR);
    await expect(existsSync(temp) ? (await import('node:fs/promises')).readdir(temp) : Promise.resolve([]))
      .resolves.toEqual([]);
  });

  it('не меняет и не удаляет источник опубликованной редакции', async () => {
    const artifacts = store();
    const uploaded = await artifacts.upload('physics-8', draftId, 'book.pdf', Readable.from(PDF));
    const topics = replaceDraftTopics(db, 'physics-8', draftId, 1, [{
      clientId: 'motion',
      title: 'Движение',
      examWeight: 1,
      difficulty: 1,
      prereqs: [],
      answerFormat: 'number',
      promptSeed: 'Скорость и путь',
    }], { createTopicToken: () => 'motion' });
    db.prepare("UPDATE course_sources SET status = 'ready' WHERE id = ?").run(uploaded.source.id);
    db.prepare(`INSERT INTO source_pages (source_id, page_number, status, text)
      VALUES (?, 1, 'ready', 'Скорость'), (?, 2, 'ready', 'Путь'), (?, 3, 'ready', 'Время')`)
      .run(uploaded.source.id, uploaded.source.id, uploaded.source.id);
    db.prepare(`INSERT INTO revision_topic_sources (revision_id, topic_id, source_id, page_from, page_to)
      VALUES (?, 'physics-8.motion', ?, 1, 3)`).run(draftId, uploaded.source.id);
    publishRevision(db, 'physics-8', draftId, topics.revision.editVersion);

    await expect(artifacts.remove('physics-8', uploaded.source.id)).rejects.toThrow(/неизменяема/u);
    await expect(artifacts.upload(
      'physics-8', draftId, 'second.pdf', Readable.from(PDF),
    )).rejects.toThrow(/неизменяема/u);
    expect(artifacts.list('physics-8')).toHaveLength(1);
  });

  it('cleanup удаляет только старые temp/orphan и сохраняет ссылочный файл', async () => {
    const artifacts = store();
    const uploaded = await artifacts.upload('physics-8', draftId, 'book.pdf', Readable.from(PDF));
    const failed = await artifacts.upload(
      'physics-8', draftId, 'failed.pdf', Readable.from(Buffer.from('%PDF-1.7\nfailed\n%%EOF\n')),
    );
    db.prepare("UPDATE course_sources SET status = 'failed', created_at = ? WHERE id = ?")
      .run(new Date(0).toISOString(), failed.source.id);
    const failedPath = db.prepare<[number], { artifact_path: string }>(
      'SELECT artifact_path FROM course_sources WHERE id = ?',
    ).get(failed.source.id)?.artifact_path;
    if (failedPath === undefined) throw new Error('нет пути failed-источника');
    const referenced = db.prepare<[number], { artifact_path: string }>(
      'SELECT artifact_path FROM course_sources WHERE id = ?',
    ).get(uploaded.source.id)?.artifact_path;
    if (referenced === undefined) throw new Error('нет пути источника');
    const orphan = resolveCatalogPath(dir, `${CATALOG_ARTIFACTS_DIR}/physics-8/${draftId}/orphan.pdf`);
    const temporary = resolveCatalogPath(dir, `${CATALOG_TEMP_DIR}/old.upload.tmp`);
    for (const path of [orphan, temporary]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'unused');
      utimesSync(path, new Date(0), new Date(0));
    }

    const removed = await artifacts.cleanupUnused(new Date('2026-01-01T00:00:00Z'));
    expect(removed).toEqual([
      `${CATALOG_ARTIFACTS_DIR}/physics-8/${draftId}/orphan.pdf`,
      `${CATALOG_TEMP_DIR}/old.upload.tmp`,
      failedPath,
    ].sort());
    expect(existsSync(resolveCatalogPath(dir, referenced))).toBe(true);
    expect(artifacts.list('physics-8').map((source) => source.id)).toEqual([uploaded.source.id]);
  });
});
