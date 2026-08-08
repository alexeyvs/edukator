import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * База версии 2: текущая схема, но `forecast_snapshots` ещё без верхней границы
 * полосы. Строится из настоящей схемы и перестройкой одной таблицы, а не своей
 * DDL: остальные таблицы версии 2 от текущих не отличаются, и вторая копия их
 * определений разъехалась бы с `SCHEMA` при первом же изменении.
 */
function createVersionTwoDatabase(path: string): Database {
  const legacy = openDatabase(path);
  legacy.exec(`
    DROP INDEX forecast_by_subject;
    DROP TABLE forecast_snapshots;
    CREATE TABLE forecast_snapshots (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL CHECK (subject IN ('math', 'russian', 'english', 'overall')),
      score REAL NOT NULL CHECK (score BETWEEN 2 AND 5),
      band REAL NOT NULL DEFAULT 0 CHECK (band >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX forecast_by_subject ON forecast_snapshots (subject, created_at);
  `);
  legacy.pragma('user_version = 2');
  return legacy;
}

/** Схема версии 5 отличается от текущей только отсутствием вида забега. */
function createVersionFiveDatabase(path: string): Database {
  const legacy = openDatabase(path);
  legacy.exec('ALTER TABLE runs DROP COLUMN kind;');
  legacy.pragma('user_version = 5');
  return legacy;
}

/** Версия 6 ещё считала runs.topic_id единственной темой всего забега. */
function createVersionSixDatabase(path: string): Database {
  const legacy = openDatabase(path);
  legacy.exec(`
    DROP TRIGGER attempts_topic_consistency_insert;
    DROP TRIGGER attempts_topic_consistency_update;
    CREATE TRIGGER attempts_topic_consistency_insert
    BEFORE INSERT ON attempts
    WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
      OR (NEW.run_id IS NOT NULL AND (SELECT topic_id FROM runs WHERE id = NEW.run_id) <> NEW.topic_id)
    BEGIN
      SELECT RAISE(ABORT, 'attempt topic must match task and run topics');
    END;
    CREATE TRIGGER attempts_topic_consistency_update
    BEFORE UPDATE OF task_id, topic_id, run_id ON attempts
    WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
      OR (NEW.run_id IS NOT NULL AND (SELECT topic_id FROM runs WHERE id = NEW.run_id) <> NEW.topic_id)
    BEGIN
      SELECT RAISE(ABORT, 'attempt topic must match task and run topics');
    END;
  `);
  legacy.pragma('user_version = 6');
  return legacy;
}

/** Версия 7 ещё не связывала выданное задание с конкретным забегом. */
function createVersionSevenDatabase(path: string): Database {
  const legacy = openDatabase(path);
  legacy.exec('ALTER TABLE task_bank DROP COLUMN issued_run_id;');
  legacy.pragma('user_version = 7');
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
    // Все прочие проверки версии сверяют базу с этой же константой и переживают
    // её подмену: `migrate` проставляет `user_version = SCHEMA_VERSION` без
    // оглядки на то, есть ли для нового номера ступень, а промежуточный DDL
    // весь `IF NOT EXISTS`. Поднятый номер без миграции молча «обновил» бы
    // рабочую базу, поэтому число прибито буквально и меняется только вместе с
    // новой ступенью и её тестом обновления.
    it('держит номер версии схемы', () => {
      expect(SCHEMA_VERSION).toBe(8);
    });

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

    // На недоступный WAL SQLite не ошибается, а оставляет прежний журнал, и
    // прежде такая база поднималась как исправная: вся расстановка транзакций
    // рассчитана на WAL, и без него параллельная запись теряется по
    // `SQLITE_BUSY` под общей пятисоткой. База в памяти WAL не умеет никогда —
    // на ней это и проверяется.
    it('отказывается открывать базу, на которой WAL не включился', () => {
      expect(() => openDatabase(':memory:')).toThrow(/WAL не включился.*memory/s);
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

    it('не повторяет миграцию, если базу мигрировал соседний процесс', () => {
      const racePath = join(tempDir, 'race.db');
      const racing = new BetterSqlite3(racePath);
      try {
        // Версия читается быстрой проверкой до транзакции, и ровно в этот момент
        // базу мигрирует другое соединение: так выглядит одновременный старт
        // сервера и `npm run prefetch` на чистом чекауте. Решение обязано
        // приниматься по перечитанной под записью версии, иначе миграция пойдёт
        // поверх готовой схемы и упадёт на «объекте profile».
        const pragma = racing.pragma.bind(racing);
        let raced = false;
        racing.pragma = (source: string, options?: Parameters<Database['pragma']>[1]): unknown => {
          const result = pragma(source, options);
          if (!raced && source === 'user_version') {
            raced = true;
            openDatabase(racePath).close();
          }
          return result;
        };

        expect(() => {
          migrate(racing);
        }).not.toThrow();
        expect(raced).toBe(true);
        expect(tableNames(racing)).toEqual([...TABLES].sort());
      } finally {
        racing.close();
      }
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

    // Схема версии 2 — текущая без затвора `band BETWEEN 0 AND 1`: снимок
    // прогноза с полосой вне диапазона в неё влезал. Без этого теста весь
    // переход `version <= 2` вырезался бы, не покраснев ни одним тестом.
    it('ставит базе версии 2 затвор полосы прогноза, сохраняя снимки', () => {
      const path = join(tempDir, 'версия-2.db');
      const legacy = createVersionTwoDatabase(path);
      legacy
        .prepare('INSERT INTO forecast_snapshots (subject, score, band) VALUES (?, ?, ?)')
        .run('math', 4.2, 0.3);
      legacy.close();

      const migrated = openDatabase(path);
      try {
        const [version] = migrated.pragma('user_version') as [{ user_version: number }];
        expect(version.user_version).toBe(SCHEMA_VERSION);
        expect(
          migrated
            .prepare<[], { subject: string; score: number; band: number }>(
              'SELECT subject, score, band FROM forecast_snapshots',
            )
            .all(),
        ).toEqual([{ subject: 'math', score: 4.2, band: 0.3 }]);

        expect(() =>
          migrated
            .prepare('INSERT INTO forecast_snapshots (subject, score, band) VALUES (?, ?, ?)')
            .run('math', 4.2, 1.5),
        ).toThrow(/CHECK/);
      } finally {
        migrated.close();
      }
    });

    // Данные, которые новый затвор не пропустит, обязаны назваться до DDL:
    // молча их отбросить значило бы потерять историю прогноза.
    it('отказывается обновлять базу версии 2 с полосой вне диапазона', () => {
      const path = join(tempDir, 'версия-2-битая.db');
      const legacy = createVersionTwoDatabase(path);
      legacy
        .prepare('INSERT INTO forecast_snapshots (subject, score, band) VALUES (?, ?, ?)')
        .run('math', 4.2, 1.5);
      legacy.close();

      expect(() => openDatabase(path)).toThrow(/полосу прогноза вне диапазона/);
    });

    // Единственная версия, которая входит в перестройку `version <= 3` со всеми
    // триггерами и индексами на месте: их приходится снимать перед
    // переименованием таблиц, иначе `SCHEMA` спотыкается о старые. Схема
    // версии 3 — текущая без отпечатка формулировки.
    it('перестраивает базу версии 3, сохраняя цепочку задание-попытка-спор', () => {
      const path = join(tempDir, 'версия-3.db');
      const legacy = openDatabase(path);
      legacy.exec('DROP INDEX task_bank_fingerprint; ALTER TABLE task_bank DROP COLUMN fingerprint;');
      const topicId = seedTopic(legacy);
      const taskId = seedTask(legacy, topicId);
      // Отметки в формате `datetime('now')`: ради их перевода в ISO переход и
      // заведён — сравнение по этим колонкам строковое.
      legacy
        .prepare('UPDATE task_bank SET created_at = ? WHERE id = ?')
        .run('2026-08-07 10:00:00', taskId);
      const attemptId = Number(
        legacy
          .prepare(
            `INSERT INTO attempts (task_id, topic_id, answer, is_correct, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(taskId, topicId, '4', 0, '2026-08-07 11:00:00').lastInsertRowid,
      );
      legacy
        .prepare(
          `INSERT INTO disputes (attempt_id, status, resolution, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(attemptId, 'upheld', 'ученик прав', '2026-08-07 11:05:00', '2026-08-07 12:34:56');
      legacy.pragma('user_version = 3');
      legacy.close();

      const migrated = openDatabase(path);
      try {
        const [version] = migrated.pragma('user_version') as [{ user_version: number }];
        expect(version.user_version).toBe(SCHEMA_VERSION);

        const task = migrated
          .prepare<[], { id: number; created_at: string; fingerprint: string }>(
            'SELECT id, created_at, fingerprint FROM task_bank',
          )
          .get();
        expect(task).toEqual({ id: taskId, created_at: '2026-08-07T10:00:00.000Z', fingerprint: '' });

        const attempt = migrated
          .prepare<[], { task_id: number; topic_id: string; created_at: string }>(
            'SELECT task_id, topic_id, created_at FROM attempts',
          )
          .get();
        expect(attempt).toEqual({
          task_id: taskId,
          topic_id: topicId,
          created_at: '2026-08-07T11:00:00.000Z',
        });

        const dispute = migrated
          .prepare<[], { attempt_id: number; resolution: string; created_at: string; resolved_at: string }>(
            'SELECT attempt_id, resolution, created_at, resolved_at FROM disputes',
          )
          .get();
        expect(dispute).toEqual({
          attempt_id: attemptId,
          resolution: 'ученик прав',
          created_at: '2026-08-07T11:05:00.000Z',
          resolved_at: '2026-08-07T12:34:56.000Z',
        });

        // Перестройка идёт переименованием, так что и внешние ключи, и снятые
        // перед ней триггеры с индексами обязаны вернуться на место.
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
        const triggers = migrated.prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'",
        ).get();
        expect(triggers?.n).toBe(4);
        migrated
          .prepare(
            `INSERT INTO task_bank (topic_id, question, answer, difficulty, fingerprint)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(topicId, 'Новое задание', '4', 2, 'новое задание');
        expect(() =>
          migrated
            .prepare(
              `INSERT INTO task_bank (topic_id, question, answer, difficulty, fingerprint)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(topicId, 'новое  задание!', '4', 2, 'новое задание'),
        ).toThrow(/UNIQUE/i);
      } finally {
        migrated.close();
      }
    });

    it('добавляет отпечаток формулировки базе версии 4, сохраняя задания', () => {
      const path = join(tempDir, 'версия-4.db');
      const legacy = openDatabase(path);
      const topicId = seedTopic(legacy);
      seedTask(legacy, topicId);
      // Схема версии 4 — текущая без отпечатка: колонка входит в индекс, так что
      // сначала снимается он.
      legacy.exec('DROP INDEX task_bank_fingerprint; ALTER TABLE task_bank DROP COLUMN fingerprint;');
      legacy.pragma('user_version = 4');
      legacy.close();

      const migrated = openDatabase(path);
      try {
        const [version] = migrated.pragma('user_version') as [{ user_version: number }];
        const rows = migrated
          .prepare<[], { question: string; fingerprint: string }>(
            'SELECT question, fingerprint FROM task_bank',
          )
          .all();

        expect(version.user_version).toBe(SCHEMA_VERSION);
        expect(rows).toEqual([{ question: 'Сколько будет 2 + 2?', fingerprint: '' }]);

        // Отпечатков у старых строк нет, и пустое значение не считается дублем;
        // новые записи уникальны по теме.
        seedTask(migrated, topicId);
        migrated
          .prepare(
            `INSERT INTO task_bank (topic_id, question, answer, difficulty, fingerprint)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(topicId, 'Новое задание', '4', 2, 'новое задание');
        expect(() =>
          migrated
            .prepare(
              `INSERT INTO task_bank (topic_id, question, answer, difficulty, fingerprint)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(topicId, 'новое  задание!', '4', 2, 'новое задание'),
        ).toThrow(/UNIQUE/i);
      } finally {
        migrated.close();
      }
    });

    it('добавляет вид забега базе версии 5 и сохраняет старые строки обычными забегами', () => {
      const path = join(tempDir, 'версия-5.db');
      const legacy = createVersionFiveDatabase(path);
      const topicId = seedTopic(legacy);
      legacy
        .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
        .run('math', topicId, '2026-08-07T10:00:00.000Z');
      legacy.close();

      const migrated = openDatabase(path);
      try {
        const [version] = migrated.pragma('user_version') as [{ user_version: number }];
        const columns = migrated
          .prepare<[], { name: string; notnull: number; dflt_value: string | null }>(
            'PRAGMA table_info(runs)',
          )
          .all();
        const run = migrated.prepare<[], { kind: string }>('SELECT kind FROM runs').get();

        expect(version.user_version).toBe(SCHEMA_VERSION);
        expect(columns.find((column) => column.name === 'kind')).toMatchObject({
          notnull: 1,
          dflt_value: "'run'",
        });
        expect(run).toEqual({ kind: 'run' });
      } finally {
        migrated.close();
      }
    });

    it('обновляет триггеры базы версии 6 для многотемного забега', () => {
      const path = join(tempDir, 'версия-6.db');
      const legacy = createVersionSixDatabase(path);
      const firstTopic = seedTopic(legacy, 'math.first');
      const nextTopic = seedTopic(legacy, 'math.next');
      const taskId = seedTask(legacy, nextTopic);
      const runId = Number(
        legacy.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', firstTopic, '2026-08-08T10:00:00.000Z').lastInsertRowid,
      );
      legacy.close();

      const migrated = openDatabase(path);
      try {
        expect(() =>
          migrated.prepare(
            `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(taskId, nextTopic, runId, '4', 1),
        ).not.toThrow();
        expect(
          (migrated.pragma('user_version') as [{ user_version: number }])[0]?.user_version,
        ).toBe(SCHEMA_VERSION);
      } finally {
        migrated.close();
      }
    });

    it('добавляет владельца выдачи базе версии 7 и сохраняет задания', () => {
      const path = join(tempDir, 'версия-7.db');
      const legacy = createVersionSevenDatabase(path);
      const topicId = seedTopic(legacy);
      const taskId = seedTask(legacy, topicId);
      legacy.prepare("UPDATE task_bank SET status = 'used' WHERE id = ?").run(taskId);
      legacy.close();

      const migrated = openDatabase(path);
      try {
        expect(migrated.prepare(
          'SELECT issued_run_id, status FROM task_bank WHERE id = ?',
        ).get(taskId)).toEqual({ issued_run_id: null, status: 'valid' });
        expect(
          (migrated.pragma('user_version') as [{ user_version: number }])[0]?.user_version,
        ).toBe(SCHEMA_VERSION);
      } finally {
        migrated.close();
      }
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

    it('отвергает неизвестный вид забега', () => {
      const topicId = seedTopic(db);

      expect(() =>
        db
          .prepare('INSERT INTO runs (subject, kind, topic_id, started_at) VALUES (?, ?, ?, ?)')
          .run('math', 'экзамен', topicId, '2026-08-07T10:00:00.000Z'),
      ).toThrow(/CHECK constraint failed/);
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

  // База с актуальным номером версии не обязана быть целой: индекс или триггер
  // мог снести кто угодно, а вместе с ними тихо отключаются защита от повторов
  // и согласованность попыток с забегами.
  describe('проверка схемы при открытии', () => {
    it('отвергает базу без обязательного индекса', () => {
      const path = join(tempDir, 'без-индекса.db');
      const seed = openDatabase(path);
      seed.exec('DROP INDEX task_bank_fingerprint');
      seed.close();

      expect(() => openDatabase(path)).toThrow(/отсутствуют task_bank_fingerprint/u);
    });

    it('отвергает базу без обязательного триггера', () => {
      const path = join(tempDir, 'без-триггера.db');
      const seed = openDatabase(path);
      seed.exec('DROP TRIGGER attempts_topic_consistency_insert');
      seed.close();

      expect(() => openDatabase(path)).toThrow(/отсутствуют attempts_topic_consistency_insert/u);
    });
  });

  describe('профиль', () => {
    it('на первом запуске отдаёт значения по умолчанию', () => {
      expect(readProfile(db)).toEqual({ ...DEFAULT_PROFILE, partnerName: '' });
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

      for (const broken of ['не json', '{"a":1}', '[1,2]', '["ок", 4]']) {
        db.prepare('UPDATE profile SET interests = ? WHERE id = 1').run(broken);
        expect(() => readProfile(db)).toThrow(/interests/);
      }
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

    it('требует совпадения темы попытки с заданием, но разрешает другую тему забега', () => {
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
      expect(() => insert.run(taskId, math, runId, '4', 1)).not.toThrow();
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

    it('пустой EDUKATOR_DB — это не путь, а умолчание', () => {
      // Пустая строка уходила в SQLite и открывала временную базу, стираемую при
      // закрытии соединения: прогресс ученика пропадал на каждом перезапуске, а
      // health при этом оставался зелёным.
      const fallback = resolve(fileURLToPath(import.meta.url), '..', '..', 'edukator.db');
      for (const value of ['', '   ']) {
        process.env.EDUKATOR_DB = value;
        try {
          expect(databasePath()).toBe(fallback);
        } finally {
          delete process.env.EDUKATOR_DB;
        }
      }
    });

    it('по умолчанию указывает на edukator.db в корне проекта', () => {
      const saved = process.env.EDUKATOR_DB;
      delete process.env.EDUKATOR_DB;
      try {
        // Полный путь, а не хвост: `/edukator\.db$/` совпал бы и с путём из
        // переменной окружения, то есть отката к умолчанию бы не доказывал.
        expect(databasePath()).toBe(resolve(fileURLToPath(import.meta.url), '..', '..', 'edukator.db'));
      } finally {
        if (saved !== undefined) process.env.EDUKATOR_DB = saved;
      }
    });

    it('падает внятной ошибкой, если каталог базы недоступен', () => {
      expect(() => openDatabase(join(tempDir, 'нет-каталога', 'x.db'))).toThrow();
    });
  });
});
