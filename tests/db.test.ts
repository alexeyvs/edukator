import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  DEFAULT_PROFILE,
  SCHEMA_VERSION,
  TABLES,
  databasePath,
  migrate,
  openDatabase,
  readProfile,
  writeProfile,
} from '../server/db.js';

/** Формат, в котором отметки времени пишет код: сравнение по колонке — строковое. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Число открытых процессом дескрипторов. Утечку соединения иначе не увидеть:
 * объект базы наружу не возвращается. На системах без `/dev/fd` (не macOS и не
 * Linux) отдаёт 0 — проверка вырождается в «не выросло», но не ломается.
 */
function openDescriptors(): number {
  return existsSync('/dev/fd') ? readdirSync('/dev/fd').length : 0;
}

function tableNames(db: Database): string[] {
  const rows = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

/** Тема нужна почти всем таблицам: на неё ссылаются задания, забеги и попытки. */
function seedTopic(db: Database, topicId = 'math.fractions'): string {
  db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run(topicId);
  return topicId;
}

function seedTask(db: Database, topicId: string): number {
  const info = db
    .prepare(
      `INSERT INTO task_bank (topic_id, question, answer, accept, difficulty)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(topicId, 'Сколько будет 2 + 2?', '4', '["4","четыре"]', 2);
  return Number(info.lastInsertRowid);
}

/** Реальная DDL версии 1: прежний тест лишь менял номер у уже новой схемы. */
function createVersionOneDatabase(path: string): Database {
  const legacy = new BetterSqlite3(path);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL DEFAULT '',
      interests TEXT NOT NULL DEFAULT '[]', exam_date TEXT, partner_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE topic_state (
      topic_id TEXT PRIMARY KEY, mastery REAL NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 1),
      confidence REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), last_seen TEXT, next_review TEXT
    );
    CREATE TABLE task_bank (
      id INTEGER PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
      question TEXT NOT NULL, answer TEXT NOT NULL, accept TEXT NOT NULL DEFAULT '[]',
      hint TEXT, explain TEXT, joke TEXT,
      difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'valid', 'rejected', 'used')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX task_bank_queue ON task_bank (topic_id, status, difficulty);
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY, subject TEXT NOT NULL CHECK (subject IN ('math', 'russian', 'english')),
      topic_id TEXT NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, finished_at TEXT,
      total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
      correct INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0)
    );
    CREATE TABLE attempts (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES task_bank (id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
      answer TEXT NOT NULL, is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
      hint_used INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX attempts_by_topic ON attempts (topic_id, created_at);
    CREATE TABLE disputes (
      id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected')),
      resolution TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
    );
    CREATE TABLE forecast_snapshots (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL CHECK (subject IN ('math', 'russian', 'english', 'overall')),
      score REAL NOT NULL CHECK (score BETWEEN 2 AND 5),
      band REAL NOT NULL DEFAULT 0 CHECK (band >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX forecast_by_subject ON forecast_snapshots (subject, created_at);
    PRAGMA user_version = 1;
  `);
  return legacy;
}

describe('база данных', () => {
  let tempDir: string;
  let dbFile: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-db-'));
    dbFile = join(tempDir, 'test.db');
    db = openDatabase(dbFile);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('миграции', () => {
    it('создаёт все семь таблиц на пустой базе', () => {
      expect(tableNames(db)).toEqual([...TABLES].sort());
    });

    it('проставляет версию схемы в user_version', () => {
      const [row] = db.pragma('user_version') as [{ user_version: number }];

      expect(row.user_version).toBe(SCHEMA_VERSION);
    });

    it('включает WAL и внешние ключи', () => {
      const [journal] = db.pragma('journal_mode') as [{ journal_mode: string }];
      const [foreignKeys] = db.pragma('foreign_keys') as [{ foreign_keys: number }];

      expect(journal.journal_mode).toBe('wal');
      expect(foreignKeys.foreign_keys).toBe(1);
    });

    it('идемпотентна: повторное открытие не теряет данные', () => {
      const topicId = seedTopic(db);
      db.prepare('UPDATE topic_state SET mastery = 0.42 WHERE topic_id = ?').run(topicId);
      writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });
      db.close();

      db = openDatabase(dbFile);

      expect(tableNames(db)).toEqual([...TABLES].sort());
      const state = db
        .prepare<[string], { mastery: number }>('SELECT mastery FROM topic_state WHERE topic_id = ?')
        .get(topicId);
      expect(state?.mastery).toBeCloseTo(0.42);
      expect(readProfile(db).name).toBe('Тимофей');
      expect(readProfile(db).interests).toEqual(['Minecraft']);
    });

    it('обновляет схему версии 1 до текущей и ставит ограничения целостности', () => {
      db.exec(`
        DROP TRIGGER runs_correct_not_above_total_insert;
        DROP TRIGGER runs_correct_not_above_total_update;
        DROP TRIGGER attempts_topic_consistency_insert;
        DROP TRIGGER attempts_topic_consistency_update;
      `);
      db.pragma('user_version = 1');
      db.close();

      db = openDatabase(dbFile);

      const [version] = db.pragma('user_version') as [{ user_version: number }];
      const triggers = db.prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'",
      ).get();
      expect(version.user_version).toBe(SCHEMA_VERSION);
      expect(triggers?.n).toBe(4);
    });

    it('обновляет ISO-умолчания реальной схемы версии 1 и сохраняет данные', () => {
      const path = join(tempDir, 'версия-1.db');
      const legacy = createVersionOneDatabase(path);
      const topicId = seedTopic(legacy);
      const taskId = seedTask(legacy, topicId);
      const attemptId = Number(
        legacy
          .prepare(
            `INSERT INTO attempts (task_id, topic_id, answer, is_correct)
             VALUES (?, ?, ?, ?)`,
          )
          .run(taskId, topicId, '4', 1).lastInsertRowid,
      );
      legacy
        .prepare('INSERT INTO disputes (attempt_id, status, resolved_at) VALUES (?, ?, ?)')
        .run(attemptId, 'upheld', '2026-08-07 12:34:56');
      legacy.close();

      const migrated = openDatabase(path);
      try {
        const newTaskId = seedTask(migrated, topicId);
        const newAttemptId = Number(
          migrated
            .prepare(
              `INSERT INTO attempts (task_id, topic_id, answer, is_correct)
               VALUES (?, ?, ?, ?)`,
            )
            .run(newTaskId, topicId, '4', 1).lastInsertRowid,
        );
        migrated.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(newAttemptId);

        for (const table of ['task_bank', 'attempts', 'disputes']) {
          const rows = migrated
            .prepare<[], { created_at: string }>(`SELECT created_at FROM ${table} ORDER BY id`)
            .all();
          expect(rows).toHaveLength(2);
          for (const row of rows) expect(row.created_at).toMatch(ISO_STAMP);
        }
        const resolved = migrated
          .prepare<[], { resolved_at: string }>('SELECT resolved_at FROM disputes WHERE id = 1')
          .get();
        expect(resolved?.resolved_at).toBe('2026-08-07T12:34:56.000Z');
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
      } finally {
        migrated.close();
      }
    });

    it('откатывает миграцию версии 1 с противоречивым забегом', () => {
      const topicId = seedTopic(db);
      db.exec(`
        DROP TRIGGER runs_correct_not_above_total_insert;
        DROP TRIGGER runs_correct_not_above_total_update;
        DROP TRIGGER attempts_topic_consistency_insert;
        DROP TRIGGER attempts_topic_consistency_update;
        PRAGMA ignore_check_constraints = ON;
      `);
      db.prepare(
        'INSERT INTO runs (subject, topic_id, started_at, total, correct) VALUES (?, ?, ?, ?, ?)',
      ).run('math', topicId, '2026-08-07T10:00:00Z', 1, 2);
      db.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA user_version = 1;');
      db.close();

      expect(() => openDatabase(dbFile)).toThrow(/противоречивые забеги или попытки/);

      db = new BetterSqlite3(dbFile);
      const [version] = db.pragma('user_version') as [{ user_version: number }];
      const triggers = db.prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'",
      ).get();
      expect(version.user_version).toBe(1);
      expect(triggers?.n).toBe(0);
    });

    it('откатывает миграцию версии 1 с несовпадающей темой попытки', () => {
      const math = seedTopic(db, 'math.a');
      const russian = seedTopic(db, 'russian.a');
      const taskId = seedTask(db, math);
      db.exec(`
        DROP TRIGGER runs_correct_not_above_total_insert;
        DROP TRIGGER runs_correct_not_above_total_update;
        DROP TRIGGER attempts_topic_consistency_insert;
        DROP TRIGGER attempts_topic_consistency_update;
      `);
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct)
         VALUES (?, ?, ?, ?)`,
      ).run(taskId, russian, '4', 1);
      db.pragma('user_version = 1');
      db.close();

      expect(() => openDatabase(dbFile)).toThrow(/противоречивые забеги или попытки/);

      db = new BetterSqlite3(dbFile);
      const [version] = db.pragma('user_version') as [{ user_version: number }];
      expect(version.user_version).toBe(1);
    });

    it('не объявляет текущей непустую базу без номера версии', () => {
      const path = join(tempDir, 'неизвестная.db');
      const unknown = new BetterSqlite3(path);
      unknown.exec('CREATE TABLE alien (id INTEGER PRIMARY KEY)');
      unknown.close();

      expect(() => openDatabase(path)).toThrow(/без версии.*alien/);

      const reopened = new BetterSqlite3(path);
      const [version] = reopened.pragma('user_version') as [{ user_version: number }];
      expect(version.user_version).toBe(0);
      reopened.close();
    });

    it('отвергает базу, собранную более новой версией схемы', () => {
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);

      expect(() => migrate(db)).toThrow(/более новой версией схемы/);
    });

    it('не оставляет открытое соединение, если миграция упала', () => {
      // Соединение открыто раньше, чем миграция падает, а наружу уходит только
      // исключение — закрыть его вызывающему нечем. /api/health открывает базу
      // на каждый запрос, так что утечка упирается в предел дескрипторов.
      const broken = join(tempDir, 'из-будущего.db');
      const seed = openDatabase(broken);
      seed.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      seed.close();

      const before = openDescriptors();
      for (let index = 0; index < 40; index += 1) {
        expect(() => openDatabase(broken)).toThrow(/более новой версией схемы/);
      }

      expect(openDescriptors() - before).toBeLessThan(10);
    });

    it('проставляет отметки времени по умолчанию в том же ISO, что и код', () => {
      const topicId = seedTopic(db);
      const taskId = seedTask(db, topicId);
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct, hint_used, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(taskId, topicId, '4', 1, 0, 900);
      db.prepare('INSERT INTO forecast_snapshots (subject, score, band) VALUES (?, ?, ?)')
        .run('math', 4.0, 0.3);

      const stamps = [
        db.prepare<[], { created_at: string }>('SELECT created_at FROM task_bank').get(),
        db.prepare<[], { created_at: string }>('SELECT created_at FROM attempts').get(),
        db.prepare<[], { created_at: string }>('SELECT created_at FROM forecast_snapshots').get(),
      ];

      for (const row of stamps) {
        expect(row?.created_at).toMatch(ISO_STAMP);
      }
      // Умолчание схемы и `toISOString()` обязаны сравниваться как строки:
      // по этой колонке идут и сортировка, и выборка периода.
      const written = stamps[2]?.created_at ?? '';
      expect(written > '2026-01-01T00:00:00.000Z').toBe(true);
    });
  });

  describe('профиль', () => {
    it('на первом запуске отдаёт значения по умолчанию', () => {
      expect(readProfile(db)).toEqual(DEFAULT_PROFILE);
    });

    it('сохраняет и читает поля профиля', () => {
      const saved = writeProfile(db, {
        name: 'Тимофей',
        interests: ['Minecraft', 'Kuplinov'],
        examDate: '2027-05-20',
        partnerName: 'Сёма',
      });

      expect(saved).toEqual({
        name: 'Тимофей',
        interests: ['Minecraft', 'Kuplinov'],
        examDate: '2027-05-20',
        partnerName: 'Сёма',
      });
      expect(readProfile(db)).toEqual(saved);
    });

    it('обновляет поля по одному, не затирая остальные', () => {
      writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });
      const updated = writeProfile(db, { partnerName: 'Сёма' });

      expect(updated.name).toBe('Тимофей');
      expect(updated.interests).toEqual(['Minecraft']);
      expect(updated.partnerName).toBe('Сёма');
    });

    it('сериализует интересы в JSON и переживает перечитывание', () => {
      writeProfile(db, { interests: ['аниме', 'скейт', 'кот «Пират»'] });

      const raw = db
        .prepare<[], { interests: string }>('SELECT interests FROM profile WHERE id = 1')
        .get();
      expect(JSON.parse(raw?.interests ?? '[]')).toEqual(['аниме', 'скейт', 'кот «Пират»']);
      expect(readProfile(db).interests).toEqual(['аниме', 'скейт', 'кот «Пират»']);
    });

    it('хранит профиль ровно одной строкой', () => {
      writeProfile(db, { name: 'Тимофей' });
      writeProfile(db, { name: 'Тимоха' });

      const rows = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM profile').get();
      expect(rows?.n).toBe(1);
    });

    it('отвергает вторую строку профиля', () => {
      expect(() => db.prepare('INSERT INTO profile (id, name) VALUES (2, ?)').run('Дубль')).toThrow(
        /CHECK constraint failed/,
      );
    });

    it('отвергает пустую дату экзамена не в формате ISO', () => {
      expect(() => writeProfile(db, { examDate: '20 мая' })).toThrow(/exam_date/);
    });

    it('отвергает дату нужной формы, но несуществующую', () => {
      // Форму такая дата проходит, а дальше Date.parse даёт NaN и планировщик
      // перестаёт строить план вообще — чинить это можно только здесь.
      for (const broken of ['2027-13-45', '2027-02-30', '2027-00-10']) {
        expect(() => writeProfile(db, { examDate: broken }), broken).toThrow(/exam_date/);
      }
      expect(readProfile(db).examDate).toBeNull();
      expect(writeProfile(db, { examDate: '2028-02-29' }).examDate).toBe('2028-02-29');
    });

    it('отвергает интересы, которые не массив строк, и оставляет профиль читаемым', () => {
      writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });

      for (const broken of ['кино', 42, ['ok', 7], null]) {
        expect(() =>
          writeProfile(db, { interests: broken as unknown as string[] }),
          JSON.stringify(broken),
        ).toThrow(/interests/);
      }
      // Профиль после отказа читается: битая запись сделала бы его
      // невосстановимым — writeProfile сам начинается с readProfile.
      expect(readProfile(db).interests).toEqual(['Minecraft']);
      expect(writeProfile(db, { interests: ['скейт'] }).interests).toEqual(['скейт']);
    });

    it('принимает сброс даты экзамена в null', () => {
      writeProfile(db, { examDate: '2027-05-20' });

      expect(writeProfile(db, { examDate: null }).examDate).toBeNull();
    });

    it('сообщает внятной ошибкой о повреждённых интересах в базе', () => {
      writeProfile(db, { name: 'Тимофей' });
      db.prepare('UPDATE profile SET interests = ? WHERE id = 1').run('не json');

      expect(() => readProfile(db)).toThrow(/interests/);
    });
  });

  describe('целостность связей', () => {
    it('отвергает задание с несуществующей темой', () => {
      expect(() => seedTask(db, 'нет.такой.темы')).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('отвергает попытку с несуществующим заданием', () => {
      const topicId = seedTopic(db);

      expect(() =>
        db
          .prepare(
            `INSERT INTO attempts (task_id, topic_id, answer, is_correct, hint_used, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(9999, topicId, '4', 1, 0, 1200),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('отвергает разбор спора по несуществующей попытке', () => {
      expect(() =>
        db.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(9999),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('принимает полную цепочку тема → задание → забег → попытка → спор', () => {
      const topicId = seedTopic(db);
      const taskId = seedTask(db, topicId);
      const runId = Number(
        db
          .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', topicId, '2026-08-07T10:00:00Z').lastInsertRowid,
      );
      const attemptId = Number(
        db
          .prepare(
            `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(taskId, topicId, runId, '4', 1, 0, 1200).lastInsertRowid,
      );

      expect(() => db.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(attemptId)).not.toThrow();
      const attempts = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM attempts').get();
      expect(attempts?.n).toBe(1);
    });

    it('отвергает верных ответов больше, чем заданий в забеге', () => {
      const topicId = seedTopic(db);
      expect(() =>
        db.prepare(
          'INSERT INTO runs (subject, topic_id, started_at, total, correct) VALUES (?, ?, ?, ?, ?)',
        ).run('math', topicId, '2026-08-07T10:00:00Z', 2, 3),
      ).toThrow(/correct|CHECK/);
    });

    it('требует совпадения темы попытки с заданием и забегом', () => {
      const math = seedTopic(db, 'math.fractions');
      const russian = seedTopic(db, 'russian.spelling');
      const taskId = seedTask(db, math);
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('russian', russian, '2026-08-07T10:00:00Z').lastInsertRowid,
      );
      const insert = db.prepare(
        `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
         VALUES (?, ?, ?, ?, ?)`,
      );
      expect(() => insert.run(taskId, russian, null, '4', 1)).toThrow(/attempt topic/);
      expect(() => insert.run(taskId, math, runId, '4', 1)).toThrow(/attempt topic/);
    });

    it('не даёт испортить корректный забег обновлением', () => {
      const topicId = seedTopic(db);
      const runId = Number(
        db.prepare(
          'INSERT INTO runs (subject, topic_id, started_at, total, correct) VALUES (?, ?, ?, ?, ?)',
        ).run('math', topicId, '2026-08-07T10:00:00Z', 2, 1).lastInsertRowid,
      );

      expect(() => db.prepare('UPDATE runs SET correct = 3 WHERE id = ?').run(runId)).toThrow(
        /correct|CHECK/,
      );
      expect(() => db.prepare('UPDATE runs SET total = 0 WHERE id = ?').run(runId)).toThrow(
        /correct|CHECK/,
      );
      expect(db.prepare<[number], { total: number; correct: number }>(
        'SELECT total, correct FROM runs WHERE id = ?',
      ).get(runId)).toEqual({ total: 2, correct: 1 });
    });

    it('не даёт поменять связи корректной попытки на другую тему', () => {
      const math = seedTopic(db, 'math.a');
      const russian = seedTopic(db, 'russian.a');
      const mathTask = seedTask(db, math);
      const russianTask = seedTask(db, russian);
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', math, '2026-08-07T10:00:00Z').lastInsertRowid,
      );
      const attemptId = Number(
        db.prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(mathTask, math, runId, '4', 1).lastInsertRowid,
      );

      expect(() => db.prepare('UPDATE attempts SET topic_id = ? WHERE id = ?')
        .run(russian, attemptId)).toThrow(/attempt topic/);
      expect(() => db.prepare('UPDATE attempts SET task_id = ? WHERE id = ?')
        .run(russianTask, attemptId)).toThrow(/attempt topic/);
      expect(db.prepare<[number], { task_id: number; topic_id: string }>(
        'SELECT task_id, topic_id FROM attempts WHERE id = ?',
      ).get(attemptId)).toEqual({ task_id: mathTask, topic_id: math });
    });

    it('отвергает mastery вне 0..1 и difficulty вне 1..3', () => {
      const topicId = seedTopic(db);

      expect(() =>
        db.prepare('UPDATE topic_state SET mastery = 1.5 WHERE topic_id = ?').run(topicId),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            'INSERT INTO task_bank (topic_id, question, answer, difficulty) VALUES (?, ?, ?, ?)',
          )
          .run(topicId, 'вопрос', 'ответ', 7),
      ).toThrow(/CHECK constraint failed/);
    });

    it('отвергает неизвестный предмет в забеге и снимке прогноза', () => {
      const topicId = seedTopic(db);

      expect(() =>
        db
          .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('химия', topicId, '2026-08-07T10:00:00Z'),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare('INSERT INTO forecast_snapshots (subject, score, band) VALUES (?, ?, ?)')
          .run('химия', 4.0, 0.3),
      ).toThrow(/CHECK constraint failed/);
    });

    it('удаляет задания и попытки вместе с исчезнувшей темой', () => {
      const topicId = seedTopic(db);
      const taskId = seedTask(db, topicId);
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct, hint_used, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(taskId, topicId, '4', 1, 0, 900);

      db.prepare('DELETE FROM topic_state WHERE topic_id = ?').run(topicId);

      const tasks = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM task_bank').get();
      const attempts = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM attempts').get();
      expect(tasks?.n).toBe(0);
      expect(attempts?.n).toBe(0);
    });
  });

  describe('путь к базе', () => {
    it('берётся из EDUKATOR_DB, когда переменная задана', () => {
      process.env.EDUKATOR_DB = join(tempDir, 'из-окружения.db');
      try {
        expect(databasePath()).toBe(join(tempDir, 'из-окружения.db'));
      } finally {
        delete process.env.EDUKATOR_DB;
      }
    });

    it('по умолчанию указывает на edukator.db в корне проекта', () => {
      delete process.env.EDUKATOR_DB;

      expect(databasePath()).toMatch(/edukator\.db$/);
    });

    it('падает внятной ошибкой, если каталог базы недоступен', () => {
      expect(() => openDatabase(join(tempDir, 'нет-каталога', 'x.db'))).toThrow();
    });
  });
});
