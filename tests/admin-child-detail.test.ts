import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import {
  childDatabasePath,
  createChild,
  createParent,
  markChildReady,
  retireChild,
  openControlDatabase,
  setParentPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { SCHEMA_VERSION, openDatabase } from '../server/db.js';
import { readChildDetail } from '../server/admin/child-detail.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const PARENT_PASSWORD = 'пароль-родителя';

function topic(id: string, subject: 'math' | 'russian' = 'math'): Topic {
  return {
    id,
    subject,
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([
  topic('math.a'),
  topic('math.b'),
  topic('russian.a', 'russian'),
]);

describe('слой 3 статистики оператора', () => {
  let dir: string;
  let control: Database;
  let parentId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-child-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    parentId = createParent(control, 'родитель@example.com', NOW);
    setParentPassword(control, parentId, PARENT_PASSWORD, NOW);
  });

  afterEach(() => {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Ребёнок с настоящей базой нынешней схемы и синхронизированной картой тем. */
  function child(name: string): string {
    const id = createChild(control, parentId, name, NOW);
    const db = openDatabase(childDatabasePath(dir, id));
    try {
      syncTopicState(db, GRAPH);
    } finally {
      db.close();
    }
    markChildReady(control, id);
    return id;
  }

  /** Открывает базу ребёнка на запись: посев идёт мимо доменных модулей. */
  function seed(childId: string, fill: (db: Database) => void): void {
    const db = openDatabase(childDatabasePath(dir, childId));
    try {
      fill(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  /** Задание банка. Формулировка приметная: по ней видно утечку содержания. */
  function addTask(db: Database, topicId: string, status: string, position = 0): number {
    const info = db
      .prepare(
        `INSERT INTO task_bank (topic_id, question, answer, difficulty, status, fingerprint, created_at)
         VALUES (?, 'СЕКРЕТНАЯ-ФОРМУЛИРОВКА', '42', 2, ?, ?, ?)`,
      )
      .run(topicId, status, `${topicId}-${status}-${position}`, NOW.toISOString());
    return Number(info.lastInsertRowid);
  }

  function addRun(db: Database, topicId: string, kind: 'run' | 'lesson' = 'run'): number {
    const info = db
      .prepare(
        `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
         VALUES ('math', ?, ?, ?, ?, '{}')`,
      )
      .run(kind, topicId, NOW.toISOString(), NOW.toISOString());
    return Number(info.lastInsertRowid);
  }

  function detail(childId: string) {
    return readChildDetail(control, { dataDir: dir, graph: GRAPH, childId, now: NOW });
  }

  it('показывает банк по темам, материалы, споры, боссов и гейт', () => {
    const id = child('Ученик');
    seed(id, (db) => {
      db.prepare('UPDATE topic_state SET mastery = 0.6, attempts = 4 WHERE topic_id = ?')
        .run('math.a');
      addTask(db, 'math.a', 'valid', 1);
      addTask(db, 'math.a', 'valid', 2);
      addTask(db, 'math.a', 'pending', 3);
      addTask(db, 'math.a', 'rejected', 4);
      addTask(db, 'math.a', 'used', 5);
      const reserved = addTask(db, 'math.b', 'boss_reserved', 6);

      const материал = db
        .prepare(
          `INSERT INTO learning_materials
             (subject, topic_id, status, recommendation_reason, mastery_before, created_at, ready_at)
           VALUES ('math', 'math.a', 'ready', 'ТАЙНАЯ-ПРИЧИНА', 0.3, ?, ?)`,
        )
        .run(NOW.toISOString(), NOW.toISOString());
      const materialId = Number(материал.lastInsertRowid);
      const lessonTask = addTask(db, 'math.a', 'lesson_reserved', 7);
      db.prepare('INSERT INTO learning_tasks (material_id, task_id, position) VALUES (?, ?, 1)')
        .run(materialId, lessonTask);
      const lessonRun = addRun(db, 'math.a', 'lesson');
      db.prepare(
        'INSERT INTO learning_runs (material_id, run_id, attempt_number) VALUES (?, ?, 1)',
      ).run(materialId, lessonRun);

      const run = addRun(db, 'math.a');
      const task = addTask(db, 'math.a', 'used', 8);
      const attempt = db
        .prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, created_at)
           VALUES (?, 'math.a', ?, 'ОТВЕТ-РЕБЁНКА', 0, ?)`,
        )
        .run(task, run, NOW.toISOString());
      db.prepare(
        `INSERT INTO disputes (attempt_id, status, resolution, created_at)
         VALUES (?, 'open', NULL, ?)`,
      ).run(Number(attempt.lastInsertRowid), NOW.toISOString());

      const бой = db
        .prepare(
          `INSERT INTO boss_batches (topic_id, status, created_at) VALUES ('math.b', 'ready', ?)`,
        )
        .run(NOW.toISOString());
      db.prepare('INSERT INTO boss_tasks (batch_id, task_id, position) VALUES (?, ?, 1)')
        .run(Number(бой.lastInsertRowid), reserved);
    });

    const card = detail(id);
    if (card?.state !== 'read') throw new Error('карточка не прочитана');

    expect(card.childId).toBe(id);
    expect(card.name).toBe('Ученик');
    expect(card.parentId).toBe(parentId);
    expect(card.schemaVersion).toBe(SCHEMA_VERSION);
    expect(card.generatedAt).toBe(NOW.toISOString());

    const mathA = card.topics.find((row) => row.topicId === 'math.a');
    expect(mathA).toMatchObject({
      title: 'Тема math.a',
      subject: 'math',
      mastery: 0.6,
      attempts: 4,
      bank: { valid: 2, pending: 1, rejected: 1, used: 2, reserved: 1 },
    });
    // Тема, до которой не дошли и заданий по которой нет, в карточку не
    // попадает: их в карте сотни, и пустая строка — не жалоба.
    expect(card.topics.map((row) => row.topicId)).toEqual(['math.a', 'math.b']);

    expect(card.materials).toMatchObject([
      { topicId: 'math.a', status: 'ready', tasks: 1, runs: 1 },
    ]);
    expect(card.disputes).toMatchObject([{ topicId: 'math.a', status: 'open' }]);
    expect(card.bosses).toMatchObject([{ topicId: 'math.b', status: 'ready', tasks: 1 }]);
    expect(card.gate).toMatchObject({ day: '2026-08-21', required: 3, unlocked: false });
  });

  it('не отдаёт ни одного текста ребёнка и модели', () => {
    const id = child('Ученик');
    seed(id, (db) => {
      const task = addTask(db, 'math.a', 'used', 1);
      const run = addRun(db, 'math.a');
      const attempt = db
        .prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, created_at)
           VALUES (?, 'math.a', ?, 'ОТВЕТ-РЕБЁНКА', 0, ?)`,
        )
        .run(task, run, NOW.toISOString());
      db.prepare(
        `INSERT INTO disputes (attempt_id, status, resolution, created_at)
         VALUES (?, 'upheld', 'РАЗБОР-МОДЕЛИ', ?)`,
      ).run(Number(attempt.lastInsertRowid), NOW.toISOString());
      db.prepare(
        `INSERT INTO learning_materials
           (subject, topic_id, status, content, recommendation_reason, mastery_before, created_at, ready_at)
         VALUES ('math', 'math.b', 'ready', 'ТАЙНАЯ-ТЕОРИЯ', 'ТАЙНАЯ-ПРИЧИНА', 0.3, ?, ?)`,
      ).run(NOW.toISOString(), NOW.toISOString());
    });

    const card = detail(id);
    const json = JSON.stringify(card);
    for (const secret of [
      'СЕКРЕТНАЯ-ФОРМУЛИРОВКА',
      'ОТВЕТ-РЕБЁНКА',
      'РАЗБОР-МОДЕЛИ',
      'ТАЙНАЯ-ТЕОРИЯ',
      'ТАЙНАЯ-ПРИЧИНА',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('опознаёт базу со старой схемой и не трогает её', () => {
    const id = child('Отставший');
    const path = childDatabasePath(dir, id);
    const raw = new BetterSqlite3(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();

    const card = detail(id);
    expect(card).toMatchObject({ state: 'stale', schemaVersion: SCHEMA_VERSION - 1 });

    const after = new BetterSqlite3(path, { readonly: true });
    const [version] = after.pragma('user_version') as [{ user_version: number }];
    after.close();
    expect(version.user_version).toBe(SCHEMA_VERSION - 1);
  });

  it('называет причину, когда базы нет вовсе', () => {
    // Заведение застряло: строка в `control.db` есть, файла базы ещё нет.
    const id = createChild(control, parentId, 'Застрявший', NOW);

    const card = detail(id);
    expect(card?.state).toBe('failed');
    if (card?.state !== 'failed') throw new Error('карточка не отказала');
    expect(card.reason).toContain(id);
    // Всё, что знает управляющая база, остаётся на месте: карточка застрявшего
    // ребёнка и нужна ровно затем, чтобы увидеть его состояние.
    expect(card.status).toBe('provisioning');
    expect(card.name).toBe('Застрявший');
  });

  it('называет причину, когда файл базы испорчен', () => {
    const id = child('Битый');
    writeFileSync(childDatabasePath(dir, id), 'это не sqlite');

    const card = detail(id);
    expect(card?.state).toBe('failed');
  });

  it('показывает заполненные отметки времени и тему, выпавшую из карты', () => {
    const id = child('Пройденный');
    control
      .prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
      .run(NOW.toISOString(), id);
    retireChild(control, id, NOW);
    seed(id, (db) => {
      db.prepare('UPDATE topic_state SET mastery = 1, attempts = 9, closed_at = ? WHERE topic_id = ?')
        .run(NOW.toISOString(), 'math.a');
      // Тема из прошлой редакции карты: строка прогресса осталась, названия
      // взять негде. Карточка обязана показать её без заголовка, а не молчать.
      db.prepare('INSERT INTO topic_state (topic_id, mastery, attempts) VALUES (?, 0.2, 3)')
        .run('math.устаревшая');

      // Материал, который ещё готовится: `ready_at` пуст, и это не то же самое,
      // что готовый и открытый.
      db.prepare(
        `INSERT INTO learning_materials
           (subject, topic_id, status, recommendation_reason, mastery_before, created_at)
         VALUES ('math', 'math.b', 'preparing', 'ПРИЧИНА', 0.4, ?)`,
      ).run(NOW.toISOString());
      db.prepare(
        `INSERT INTO learning_materials
           (subject, topic_id, status, recommendation_reason, mastery_before,
            created_at, ready_at, opened_at, finished_at)
         VALUES ('math', 'math.a', 'passed', 'ПРИЧИНА', 0.4, ?, ?, ?, ?)`,
      ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

      const run = addRun(db, 'math.a');
      const task = addTask(db, 'math.a', 'used', 1);
      const attempt = db
        .prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, created_at)
           VALUES (?, 'math.a', ?, 'ОТВЕТ-РЕБЁНКА', 0, ?)`,
        )
        .run(task, run, NOW.toISOString());
      db.prepare(
        `INSERT INTO disputes (attempt_id, status, resolution, created_at, resolved_at)
         VALUES (?, 'upheld', 'РАЗБОР-МОДЕЛИ', ?, ?)`,
      ).run(Number(attempt.lastInsertRowid), NOW.toISOString(), NOW.toISOString());

      db.prepare(
        `INSERT INTO boss_batches (topic_id, status, created_at, activated_at, finished_at)
         VALUES ('math.b', 'won', ?, ?, ?)`,
      ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    });

    const card = detail(id);
    if (card?.state !== 'read') throw new Error('карточка не прочитана');

    expect(card.lastActivityAt).toBe(NOW.toISOString());
    expect(card.retiredAt).toBe(NOW.toISOString());

    const closed = card.topics.find((row) => row.topicId === 'math.a');
    expect(closed?.closedAt).toBe(NOW.toISOString());
    const orphan = card.topics.find((row) => row.topicId === 'math.устаревшая');
    expect(orphan).toMatchObject({ mastery: 0.2, attempts: 3 });
    expect(orphan?.title).toBeUndefined();
    expect(orphan?.subject).toBeUndefined();

    const preparing = card.materials.find((row) => row.status === 'preparing');
    expect(preparing?.readyAt).toBeUndefined();
    expect(card.materials.find((row) => row.status === 'passed')).toMatchObject({
      readyAt: NOW.toISOString(),
      openedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    });

    expect(card.disputes[0]?.resolvedAt).toBe(NOW.toISOString());
    expect(card.bosses[0]).toMatchObject({
      activatedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    });
  });

  it('без явного времени отмечает карточку нынешним', () => {
    const id = child('Ученик');
    const before = Date.now();

    const card = readChildDetail(control, { dataDir: dir, graph: GRAPH, childId: id });

    if (card?.state !== 'read') throw new Error('карточка не прочитана');
    const generated = Date.parse(card.generatedAt);
    expect(generated).toBeGreaterThanOrEqual(before);
    expect(generated).toBeLessThanOrEqual(Date.now());
  });

  it('не находит ребёнка, которого нет в управляющей базе', () => {
    expect(detail('0123456789abcdef')).toBeUndefined();
    // Чужой формат идентификатора отвечает тем же самым: путь по нему не
    // считается вовсе, и «нет такого» — единственный честный ответ.
    expect(detail('../control')).toBeUndefined();
  });
});
