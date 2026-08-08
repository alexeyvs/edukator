import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * Версия схемы. Хранится в `PRAGMA user_version`; миграция сравнивает её со
 * своей и пропускает работу, если база уже актуальна.
 */
export const SCHEMA_VERSION = 11;

/** Таблицы приложения. Тесты сверяют состав базы именно с этим списком. */
export const TABLES = [
  'profile',
  'topic_state',
  'task_bank',
  'runs',
  'attempts',
  'disputes',
  'forecast_snapshots',
  'boss_batches',
  'boss_tasks',
] as const;

/** Предметы подготовки. Ограничение уровня схемы, чтобы опечатка не дошла до отчётов. */
export const SUBJECTS = ['math', 'russian', 'english'] as const;
export type Subject = (typeof SUBJECTS)[number];

/**
 * Человеческие названия предметов для промптов. Живут рядом с `SUBJECTS`, а не
 * у каждого промпта свои: две копии значат, что переименование предмета молча
 * даст сборке карты тем и генератору заданий разный словарь.
 */
export const SUBJECT_TITLES: Record<Subject, string> = {
  math: 'математика',
  russian: 'русский язык',
  english: 'английский язык',
};

export interface Profile {
  name: string;
  /** Игры, стримеры, увлечения — подставляются в промпт генерации заданий. */
  interests: string[];
  /** ISO-дата `YYYY-MM-DD` либо `null`, пока дата экзамена неизвестна. */
  examDate: string | null;
  /** Имя ИИ-напарника: при первом запуске он предлагает себя переименовать. */
  partnerName: string;
}

export const DEFAULT_PROFILE: Profile = {
  name: 'Ученик',
  interests: [],
  examDate: null,
  partnerName: 'Напарник',
};

/** Пределы профиля одновременно берегут базу, HTTP и аргумент запуска codex. */
export const PROFILE_NAME_MAX_LENGTH = 200;
export const PROFILE_INTERESTS_MAX = 12;
export const PROFILE_INTEREST_MAX_LENGTH = 200;

export class ProfileValidationError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Отметка времени в том же ISO-формате, в котором её пишет код (`toISOString`).
 * Умолчание `datetime('now')` дало бы `YYYY-MM-DD HH:MM:SS`, а по этим колонкам
 * идут сортировка и выборка периода обычным сравнением строк — два формата в
 * одной колонке сравнивались бы как попало.
 */
const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const subjectCheck = SUBJECTS.map((subject) => `'${subject}'`).join(', ');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profile (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    name         TEXT    NOT NULL DEFAULT '',
    interests    TEXT    NOT NULL DEFAULT '[]',
    exam_date    TEXT,
    partner_name TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS topic_state (
    topic_id    TEXT    PRIMARY KEY,
    mastery     REAL    NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 1),
    confidence  REAL    NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
    attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_seen   TEXT,
    next_review TEXT,
    closed_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS task_bank (
    id         INTEGER PRIMARY KEY,
    topic_id   TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    question   TEXT    NOT NULL,
    instruction TEXT,
    material   TEXT,
    material_format TEXT CHECK (material_format IN ('none', 'text', 'math')),
    choices    TEXT,
    answer     TEXT    NOT NULL,
    accept     TEXT    NOT NULL DEFAULT '[]',
    hint       TEXT,
    explain    TEXT,
    joke       TEXT,
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
    status     TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'valid', 'rejected', 'used', 'boss_reserved')),
    -- Отпечаток формулировки (questionFingerprint): по нему банк отсекает
    -- повторы внутри темы.
    fingerprint TEXT   NOT NULL DEFAULT '',
    issued_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS task_bank_queue
    ON task_bank (topic_id, status, difficulty);

  -- Индекс частичный: у строк, записанных до версии 5, отпечатка нет, и пустое
  -- значение не должно означать, что они все дубли друг друга.
  CREATE UNIQUE INDEX IF NOT EXISTS task_bank_fingerprint
    ON task_bank (topic_id, fingerprint) WHERE fingerprint <> '';

  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    subject     TEXT    NOT NULL CHECK (subject IN (${subjectCheck})),
    kind        TEXT    NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'triage', 'boss')),
    -- Тема, ради которой забег начат. Внутри забега задания могут относиться к
    -- другим темам предмета; это поле читают планировочные эвристики
    -- activeRunTopics, topicsUsedToday и lastRunSubject.
    topic_id    TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    started_at  TEXT    NOT NULL,
    finished_at TEXT,
    summary     TEXT,
    total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
    correct     INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0 AND correct <= total)
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id          INTEGER PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES task_bank (id) ON DELETE CASCADE,
    topic_id    TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    run_id      INTEGER REFERENCES runs (id) ON DELETE SET NULL,
    answer      TEXT    NOT NULL,
    is_correct  INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
    hint_used   INTEGER NOT NULL DEFAULT 0 CHECK (hint_used IN (0, 1)),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at  TEXT    NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS attempts_by_topic ON attempts (topic_id, created_at);

  CREATE TRIGGER IF NOT EXISTS runs_correct_not_above_total_insert
  BEFORE INSERT ON runs
  WHEN NEW.correct > NEW.total
  BEGIN
    SELECT RAISE(ABORT, 'runs.correct cannot exceed runs.total');
  END;

  CREATE TRIGGER IF NOT EXISTS runs_correct_not_above_total_update
  BEFORE UPDATE OF correct, total ON runs
  WHEN NEW.correct > NEW.total
  BEGIN
    SELECT RAISE(ABORT, 'runs.correct cannot exceed runs.total');
  END;

  CREATE TRIGGER IF NOT EXISTS attempts_topic_consistency_insert
  BEFORE INSERT ON attempts
  WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
  BEGIN
    SELECT RAISE(ABORT, 'attempt topic must match task topic');
  END;

  CREATE TRIGGER IF NOT EXISTS attempts_topic_consistency_update
  BEFORE UPDATE OF task_id, topic_id, run_id ON attempts
  WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
  BEGIN
    SELECT RAISE(ABORT, 'attempt topic must match task topic');
  END;

  CREATE TABLE IF NOT EXISTS disputes (
    id          INTEGER PRIMARY KEY,
    attempt_id  INTEGER NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'upheld', 'rejected')),
    resolution  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS forecast_snapshots (
    id         INTEGER PRIMARY KEY,
    subject    TEXT    NOT NULL CHECK (subject IN (${subjectCheck}, 'overall')),
    score      REAL    NOT NULL CHECK (score BETWEEN 2 AND 5),
    band       REAL    NOT NULL DEFAULT 0 CHECK (band BETWEEN 0 AND 1),
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS forecast_by_subject
    ON forecast_snapshots (subject, created_at);

  CREATE TABLE IF NOT EXISTS boss_batches (
    id           INTEGER PRIMARY KEY,
    topic_id     TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    run_id       INTEGER REFERENCES runs (id) ON DELETE SET NULL,
    status       TEXT    NOT NULL DEFAULT 'preparing'
                         CHECK (status IN ('preparing', 'ready', 'active', 'won', 'lost', 'failed')),
    created_at   TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    activated_at TEXT,
    finished_at  TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS boss_batches_live_topic
    ON boss_batches (topic_id)
    WHERE status IN ('preparing', 'ready', 'active');

  CREATE TABLE IF NOT EXISTS boss_tasks (
    batch_id INTEGER NOT NULL REFERENCES boss_batches (id) ON DELETE CASCADE,
    task_id  INTEGER NOT NULL REFERENCES task_bank (id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
    PRIMARY KEY (batch_id, position),
    UNIQUE (task_id)
  );
`;

/**
 * Путь к базе: переопределяется через EDUKATOR_DB, чтобы тесты и dev-запуск
 * не дрались за один файл.
 *
 * Пустое значение — это незаданная переменная, а не путь: `??` ловит только
 * отсутствие, а `EDUKATOR_DB=` уходило пустой строкой в SQLite, и та молча
 * открывала временную базу, стираемую при закрытии соединения. Прогресс ученика
 * пропадал бы на каждом перезапуске, а `/api/health` при этом оставался зелёным.
 */
export function databasePath(): string {
  const value = process.env.EDUKATOR_DB;
  if (value === undefined || value.trim() === '') return resolve(projectRoot, 'edukator.db');
  return value;
}

/**
 * Номер версии схемы базы. База новее кода отвергается, а не считается
 * мигрированной: пропустить её молча значило бы работать с чужой схемой и
 * портить данные, которых этот код не понимает.
 */
function readUserVersion(db: Database.Database): number {
  const [row] = db.pragma('user_version') as [{ user_version: number }];
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(
      `База собрана более новой версией схемы (${row.user_version} > ${SCHEMA_VERSION}): обновите приложение`,
    );
  }
  return row.user_version;
}

/**
 * Приводит базу к текущей версии схемы. Идемпотентна: на уже мигрированной базе
 * ничего не выполняет, данные не трогает. Вся DDL идёт одной транзакцией —
 * оборванная миграция не оставляет половину таблиц.
 */
export function migrate(db: Database.Database): void {
  if (readUserVersion(db) === SCHEMA_VERSION) return;

  // Версия перечитывается под записью, а транзакция именно `immediate`: между
  // быстрой проверкой выше и первым запросом транзакции базу мог мигрировать
  // соседний процесс (сервер и `npm run prefetch` открывают её одновременно, а
  // на чистом чекауте оба видят версию 0). Отложенная транзакция повторила бы
  // миграцию поверх уже готовой схемы и упала бы «база без версии содержит
  // объект profile» на совершенно исправной базе.
  db.transaction(() => {
    const version = readUserVersion(db);
    if (version === SCHEMA_VERSION) return;

    if (version === 0) {
      const existing = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
            WHERE type IN ('table', 'index', 'trigger')
              AND name NOT LIKE 'sqlite_%'
            LIMIT 1`,
        )
        .get();
      if (existing !== undefined) {
        throw new Error(
          `База без версии содержит объект «${existing.name}»; автоматическая миграция неизвестной схемы запрещена`,
        );
      }
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }

    // Колонка отпечатка добавляется раньше любых `db.exec(SCHEMA)` ниже: SCHEMA
    // строит по ней уникальный индекс, а существующую с версии 1 таблицу
    // `CREATE TABLE IF NOT EXISTS` не обновляет — индекс упал бы на нет колонки.
    // Отпечатки старых строк не восстанавливаются: считать их пришлось бы второй,
    // SQL-реализацией нормализации, а частичный индекс пустое значение дублем и
    // не считает.
    const taskBankColumns = db
      .prepare<[], { name: string }>('PRAGMA table_info(task_bank)')
      .all()
      .map((column) => column.name);
    if (taskBankColumns.length > 0 && !taskBankColumns.includes('fingerprint')) {
      db.exec(`ALTER TABLE task_bank ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''`);
    }

    if (version === 1) {
      const badRun = db.prepare('SELECT id FROM runs WHERE correct > total LIMIT 1').get();
      const badAttempt = db.prepare(
        `SELECT attempts.id
           FROM attempts
           JOIN task_bank ON task_bank.id = attempts.task_id
           LEFT JOIN runs ON runs.id = attempts.run_id
          WHERE task_bank.topic_id <> attempts.topic_id
             OR (attempts.run_id IS NOT NULL AND runs.topic_id <> attempts.topic_id)
          LIMIT 1`,
      ).get();
      if (badRun !== undefined || badAttempt !== undefined) {
        throw new Error('База содержит противоречивые забеги или попытки; исправьте данные перед миграцией');
      }
      db.exec(SCHEMA);
    }

    if (version <= 2) {
      const badBand = db
        .prepare('SELECT id FROM forecast_snapshots WHERE band < 0 OR band > 1 LIMIT 1')
        .get();
      if (badBand !== undefined) {
        throw new Error('База содержит полосу прогноза вне диапазона 0..1; исправьте данные перед миграцией');
      }
      db.exec(`
        ALTER TABLE forecast_snapshots RENAME TO forecast_snapshots_v2;
        CREATE TABLE forecast_snapshots (
          id         INTEGER PRIMARY KEY,
          subject    TEXT    NOT NULL CHECK (subject IN (${subjectCheck}, 'overall')),
          score      REAL    NOT NULL CHECK (score BETWEEN 2 AND 5),
          band       REAL    NOT NULL DEFAULT 0 CHECK (band BETWEEN 0 AND 1),
          created_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
        );
        INSERT INTO forecast_snapshots (id, subject, score, band, created_at)
          SELECT id, subject, score, band, created_at FROM forecast_snapshots_v2;
        DROP TABLE forecast_snapshots_v2;
        CREATE INDEX forecast_by_subject ON forecast_snapshots (subject, created_at);
      `);
    }

    if (version <= 3) {
      // CREATE TABLE IF NOT EXISTS не меняет DEFAULT у существующей колонки.
      // Поэтому базы версий 1-3 продолжали писать datetime('now') в эти три
      // таблицы даже после появления ISO-умолчаний в SCHEMA. Таблицы образуют
      // цепочку внешних ключей, так что перестраиваются вместе, от дочерней к
      // родительской при переименовании и обратно при копировании.
      db.exec(`
        DROP TRIGGER IF EXISTS attempts_topic_consistency_insert;
        DROP TRIGGER IF EXISTS attempts_topic_consistency_update;
        DROP INDEX IF EXISTS attempts_by_topic;
        DROP INDEX IF EXISTS task_bank_queue;
        DROP INDEX IF EXISTS task_bank_fingerprint;

        ALTER TABLE disputes RENAME TO disputes_v3;
        ALTER TABLE attempts RENAME TO attempts_v3;
        ALTER TABLE task_bank RENAME TO task_bank_v3;
      `);
      db.exec(SCHEMA);
      db.exec(`
        INSERT INTO task_bank
          (id, topic_id, question, answer, accept, hint, explain, joke, difficulty, status, created_at)
          SELECT id, topic_id, question, answer, accept, hint, explain, joke, difficulty, status,
                 CASE WHEN created_at LIKE '____-__-__ __:__:__%'
                      THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at) ELSE created_at END
          FROM task_bank_v3;
        INSERT INTO attempts
          (id, task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, created_at)
          SELECT id, task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms,
                 CASE WHEN created_at LIKE '____-__-__ __:__:__%'
                      THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at) ELSE created_at END
          FROM attempts_v3;
        INSERT INTO disputes
          (id, attempt_id, status, resolution, created_at, resolved_at)
          SELECT id, attempt_id, status, resolution,
                 CASE WHEN created_at LIKE '____-__-__ __:__:__%'
                      THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at) ELSE created_at END,
                 CASE WHEN resolved_at LIKE '____-__-__ __:__:__%'
                      THEN strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) ELSE resolved_at END
          FROM disputes_v3;

        UPDATE forecast_snapshots
           SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
         WHERE created_at LIKE '____-__-__ __:__:__%';

        DROP TABLE disputes_v3;
        DROP TABLE attempts_v3;
        DROP TABLE task_bank_v3;
      `);
    }

    if (version <= 4) {
      // Колонка уже добавлена выше; базе версии 4 не хватает только индекса —
      // базы версий 1-3 получили его вместе с SCHEMA.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_bank_fingerprint
          ON task_bank (topic_id, fingerprint) WHERE fingerprint <> '';
      `);
    }

    if (version <= 5) {
      const runColumns = db
        .prepare<[], { name: string }>('PRAGMA table_info(runs)')
        .all()
        .map((column) => column.name);
      if (!runColumns.includes('kind')) {
        db.exec(`
          ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run'
            CHECK (kind IN ('run', 'triage'));
        `);
      }
    }

    if (version <= 6) {
      // До появления многотемных забегов триггер ошибочно считал runs.topic_id
      // единственной допустимой темой. Теперь это стартовая тема забега, а
      // принадлежность задания его предмету проверяет session до записи.
      db.exec(`
        DROP TRIGGER IF EXISTS attempts_topic_consistency_insert;
        DROP TRIGGER IF EXISTS attempts_topic_consistency_update;

        CREATE TRIGGER attempts_topic_consistency_insert
        BEFORE INSERT ON attempts
        WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
        BEGIN
          SELECT RAISE(ABORT, 'attempt topic must match task topic');
        END;

        CREATE TRIGGER attempts_topic_consistency_update
        BEFORE UPDATE OF task_id, topic_id, run_id ON attempts
        WHEN (SELECT topic_id FROM task_bank WHERE id = NEW.task_id) <> NEW.topic_id
        BEGIN
          SELECT RAISE(ABORT, 'attempt topic must match task topic');
        END;
      `);
    }

    if (version <= 7) {
      const columns = db
        .prepare<[], { name: string }>('PRAGMA table_info(task_bank)')
        .all()
        .map((column) => column.name);
      if (!columns.includes('issued_run_id')) {
        db.exec(`
          ALTER TABLE task_bank ADD COLUMN issued_run_id INTEGER
            REFERENCES runs (id) ON DELETE SET NULL;
          UPDATE task_bank SET status = 'valid'
           WHERE status = 'used'
             AND NOT EXISTS (
               SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id
             );
        `);
      }
    }

    if (version <= 8) {
      const columns = db
        .prepare<[], { name: string }>('PRAGMA table_info(runs)')
        .all()
        .map((column) => column.name);
      if (!columns.includes('summary')) {
        db.exec('ALTER TABLE runs ADD COLUMN summary TEXT;');
      }
    }

    if (version <= 9) {
      const columns = db
        .prepare<[], { name: string }>('PRAGMA table_info(task_bank)')
        .all()
        .map((column) => column.name);
      if (!columns.includes('instruction')) {
        db.exec(`
          ALTER TABLE task_bank ADD COLUMN instruction TEXT;
          ALTER TABLE task_bank ADD COLUMN material TEXT;
          ALTER TABLE task_bank ADD COLUMN material_format TEXT
            CHECK (material_format IN ('none', 'text', 'math'));
          ALTER TABLE task_bank ADD COLUMN choices TEXT;
        `);
      }
      // Старую очередь нельзя показать новым интерфейсом без надёжного деления
      // question на инструкцию и материал. Уже выданные строки остаются ради
      // попыток, споров и восстановления открытого задания.
      db.exec(`
        UPDATE task_bank SET status = 'rejected'
         WHERE status IN ('pending', 'valid')
           AND EXISTS (SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id);
        DELETE FROM task_bank
         WHERE status IN ('pending', 'valid')
           AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id);
      `);
    }

    if (version <= 10) {
      const topicColumns = db
        .prepare<[], { name: string }>('PRAGMA table_info(topic_state)')
        .all()
        .map((column) => column.name);
      if (!topicColumns.includes('closed_at')) {
        db.exec('ALTER TABLE topic_state ADD COLUMN closed_at TEXT;');
      }

      // Оба новых значения входят в CHECK существующих таблиц, поэтому одного
      // ALTER TABLE недостаточно. Цепочка перестраивается целиком: переименование
      // родителя отдельно перенаправило бы внешние ключи детей на временную
      // таблицу и сделало их висячими после DROP.
      db.exec(`
        DROP TABLE IF EXISTS boss_tasks;
        DROP TABLE IF EXISTS boss_batches;
        DROP TRIGGER IF EXISTS attempts_topic_consistency_insert;
        DROP TRIGGER IF EXISTS attempts_topic_consistency_update;
        DROP TRIGGER IF EXISTS runs_correct_not_above_total_insert;
        DROP TRIGGER IF EXISTS runs_correct_not_above_total_update;
        DROP INDEX IF EXISTS attempts_by_topic;
        DROP INDEX IF EXISTS task_bank_queue;
        DROP INDEX IF EXISTS task_bank_fingerprint;

        ALTER TABLE disputes RENAME TO disputes_v10;
        ALTER TABLE attempts RENAME TO attempts_v10;
        ALTER TABLE task_bank RENAME TO task_bank_v10;
        ALTER TABLE runs RENAME TO runs_v10;
      `);
      db.exec(SCHEMA);
      db.exec(`
        INSERT INTO runs
          (id, subject, kind, topic_id, started_at, finished_at, summary, total, correct)
          SELECT id, subject, kind, topic_id, started_at, finished_at, summary, total, correct
          FROM runs_v10;
        INSERT INTO task_bank
          (id, topic_id, question, instruction, material, material_format, choices,
           answer, accept, hint, explain, joke, difficulty, status, fingerprint,
           issued_run_id, created_at)
          SELECT id, topic_id, question, instruction, material, material_format, choices,
                 answer, accept, hint, explain, joke, difficulty, status, fingerprint,
                 issued_run_id, created_at
          FROM task_bank_v10;
        INSERT INTO attempts
          (id, task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, created_at)
          SELECT id, task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, created_at
          FROM attempts_v10;
        INSERT INTO disputes
          (id, attempt_id, status, resolution, created_at, resolved_at)
          SELECT id, attempt_id, status, resolution, created_at, resolved_at
          FROM disputes_v10;

        DROP TABLE disputes_v10;
        DROP TABLE attempts_v10;
        DROP TABLE task_bank_v10;
        DROP TABLE runs_v10;
      `);

      const [foreignKeyProblem] = db.pragma('foreign_key_check') as unknown[];
      if (foreignKeyProblem !== undefined) {
        throw new Error('Миграция игрового слоя нарушила целостность внешних ключей');
      }
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

const REQUIRED_COLUMNS: Readonly<Record<(typeof TABLES)[number], readonly string[]>> = {
  profile: ['id', 'name', 'interests', 'exam_date', 'partner_name'],
  topic_state: ['topic_id', 'mastery', 'confidence', 'attempts', 'last_seen', 'next_review', 'closed_at'],
  task_bank: ['id', 'topic_id', 'question', 'instruction', 'material', 'material_format', 'choices', 'answer', 'accept', 'hint', 'explain', 'joke', 'difficulty', 'status', 'fingerprint', 'issued_run_id', 'created_at'],
  runs: ['id', 'subject', 'kind', 'topic_id', 'started_at', 'finished_at', 'summary', 'total', 'correct'],
  attempts: ['id', 'task_id', 'topic_id', 'run_id', 'answer', 'is_correct', 'hint_used', 'duration_ms', 'created_at'],
  disputes: ['id', 'attempt_id', 'status', 'resolution', 'created_at', 'resolved_at'],
  forecast_snapshots: ['id', 'subject', 'score', 'band', 'created_at'],
  boss_batches: ['id', 'topic_id', 'run_id', 'status', 'created_at', 'activated_at', 'finished_at'],
  boss_tasks: ['batch_id', 'task_id', 'position'],
};

const REQUIRED_AUXILIARY_OBJECTS = [
  'task_bank_queue',
  'task_bank_fingerprint',
  'attempts_by_topic',
  'forecast_by_subject',
  'runs_correct_not_above_total_insert',
  'runs_correct_not_above_total_update',
  'attempts_topic_consistency_insert',
  'attempts_topic_consistency_update',
  'boss_batches_live_topic',
] as const;

const REQUIRED_SCHEMA_FRAGMENTS = {
  runs: ["'run', 'triage', 'boss'"],
  task_bank: ["'pending', 'valid', 'rejected', 'used', 'boss_reserved'"],
  boss_batches: ["'preparing', 'ready', 'active', 'won', 'lost', 'failed'"],
  boss_tasks: ['position BETWEEN 1 AND 5', 'UNIQUE (task_id)'],
} as const;

/** Не даёт базе с актуальным номером версии скрыть удалённую или чужую схему. */
export function validateSchema(db: Database.Database): void {
  for (const table of TABLES) {
    const columns = db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    const missing = REQUIRED_COLUMNS[table].filter((column) => !columns.includes(column));
    if (missing.length > 0) {
      throw new Error(`Схема базы повреждена: ${table} не содержит ${missing.join(', ')}`);
    }
  }

  const objects = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger')",
      )
      .all()
      .map((row) => row.name),
  );
  const missing = REQUIRED_AUXILIARY_OBJECTS.filter((name) => !objects.has(name));
  if (missing.length > 0) {
    throw new Error(`Схема базы повреждена: отсутствуют ${missing.join(', ')}`);
  }

  for (const [table, fragments] of Object.entries(REQUIRED_SCHEMA_FRAGMENTS)) {
    const row = db
      .prepare<[string], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    const sql = row?.sql ?? '';
    const absent = fragments.filter((fragment) => !sql.includes(fragment));
    if (absent.length > 0) {
      throw new Error(`Схема базы повреждена: ${table} не содержит обязательные ограничения`);
    }
  }

  const [integrity] = db.pragma('quick_check') as [{ quick_check: string }];
  if (integrity.quick_check !== 'ok') {
    throw new Error(`SQLite quick_check: ${integrity.quick_check}`);
  }
}

/**
 * Открывает базу, включает WAL и внешние ключи и мигрирует схему.
 * WAL нужен, чтобы фоновый воркер генерации не блокировал чтение во время забега;
 * внешние ключи в SQLite выключены по умолчанию и включаются на каждом соединении.
 */
export interface OpenDatabaseOptions {
  fileMustExist?: boolean;
}

export function openDatabase(
  path: string = databasePath(),
  options: OpenDatabaseOptions = {},
): Database.Database {
  const db = new Database(path, { fileMustExist: options.fileMustExist ?? false });
  try {
    // Результат прагмы проверяется, а не отбрасывается: на недоступный WAL
    // SQLite не ошибается, а молча возвращает журнал, который остался в силе
    // (сетевой том, база в памяти). А на WAL держится вся расстановка
    // транзакций: без него запись `npm run prefetch` берёт эксклюзивную
    // блокировку на весь файл, и ответ ученика теряется по `SQLITE_BUSY` под
    // общей пятисоткой — без единого следа о причине.
    const journal = db.pragma('journal_mode = WAL', { simple: true });
    if (journal !== 'wal') {
      throw new Error(`База ${path}: WAL не включился, журнал остался «${String(journal)}»`);
    }
    db.pragma('foreign_keys = ON');
    migrate(db);
    validateSchema(db);
  } catch (error) {
    // Соединение уже открыто, а наружу уходит только исключение — закрывать его
    // вызывающему нечем. Без этого каждая неудачная миграция (их делает и
    // /api/health на каждый запрос) утекает дескриптором до EMFILE.
    try {
      db.close();
    } catch {
      // Отказ закрытия не имеет права заслонить причину: наружу уходит она.
    }
    throw error;
  }
  return db;
}

interface ProfileRow {
  name: string;
  interests: string;
  exam_date: string | null;
  partner_name: string;
}

function parseInterests(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Профиль повреждён: поле interests не разбирается как JSON (${raw})`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Профиль повреждён: поле interests должно быть массивом строк');
  }
  return parsed as string[];
}

/**
 * Читает профиль. Строки нет — отдаёт значения по умолчанию, не создавая её:
 * запись появляется при первом сохранении, чтение остаётся безопасным.
 */
export function readProfile(db: Database.Database): Profile {
  const row = db
    .prepare<[], ProfileRow>(
      'SELECT name, interests, exam_date, partner_name FROM profile WHERE id = 1',
    )
    .get();
  if (row === undefined) {
    return { ...DEFAULT_PROFILE, interests: [...DEFAULT_PROFILE.interests], partnerName: '' };
  }

  return {
    name: row.name,
    interests: parseInterests(row.interests),
    examDate: row.exam_date,
    partnerName: row.partner_name,
  };
}

/**
 * Дата не только нужной формы, но и существующая: `2027-13-45` проходит по
 * регулярке, а дальше `Date.parse` в планировщике отдаёт `NaN`, и план перестаёт
 * строиться вообще. Проверка при записи — единственное место, где это ещё чинится.
 */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Сохраняет переданные поля профиля поверх текущих (или поверх значений по
 * умолчанию при первом запуске) и возвращает результат целиком.
 *
 * Значения проверяются до записи: строка, которую `readProfile` не сможет
 * разобрать, сделала бы профиль нечитаемым навсегда — `writeProfile` сам
 * начинается с чтения, так что починить его через этот же интерфейс не выйдет.
 */
export function writeProfile(db: Database.Database, patch: Partial<Profile>): Profile {
  if (
    patch.examDate !== undefined &&
    patch.examDate !== null &&
    (!ISO_DATE.test(patch.examDate) || !isRealDate(patch.examDate))
  ) {
    throw new Error(`Некорректная дата экзамена (exam_date): ожидается YYYY-MM-DD, получено «${patch.examDate}»`);
  }

  if (
    patch.interests !== undefined &&
    (!Array.isArray(patch.interests) || patch.interests.some((item) => typeof item !== 'string'))
  ) {
    throw new ProfileValidationError('Некорректные интересы (interests): ожидается массив строк');
  }
  if (patch.name !== undefined && patch.name.length > PROFILE_NAME_MAX_LENGTH) {
    throw new ProfileValidationError(
      `Имя ученика длиннее ${PROFILE_NAME_MAX_LENGTH} знаков`,
    );
  }
  if (patch.partnerName !== undefined && patch.partnerName.length > PROFILE_NAME_MAX_LENGTH) {
    throw new ProfileValidationError(
      `Имя напарника длиннее ${PROFILE_NAME_MAX_LENGTH} знаков`,
    );
  }
  if (patch.interests !== undefined && patch.interests.length > PROFILE_INTERESTS_MAX) {
    throw new ProfileValidationError(
      `Интересов должно быть не больше ${PROFILE_INTERESTS_MAX}`,
    );
  }
  if (
    patch.interests?.some((interest) => interest.length > PROFILE_INTEREST_MAX_LENGTH) === true
  ) {
    throw new ProfileValidationError(
      `Каждый интерес должен быть не длиннее ${PROFILE_INTEREST_MAX_LENGTH} знаков`,
    );
  }

  // Чтение и запись одной `immediate`-транзакцией: патч накладывается на текущий
  // профиль, поэтому чужая запись между ними просто исчезла бы, а под WAL
  // отложенная транзакция ещё и упала бы `SQLITE_BUSY_SNAPSHOT` на самой записи.
  return db.transaction((): Profile => {
    const next: Profile = { ...readProfile(db), ...patch };

    db.prepare(
      `INSERT INTO profile (id, name, interests, exam_date, partner_name)
       VALUES (1, @name, @interests, @examDate, @partnerName)
       ON CONFLICT (id) DO UPDATE SET
         name         = excluded.name,
         interests    = excluded.interests,
         exam_date    = excluded.exam_date,
         partner_name = excluded.partner_name`,
    ).run({
      name: next.name,
      interests: JSON.stringify(next.interests),
      examDate: next.examDate,
      partnerName: next.partnerName,
    });

    return next;
  }).immediate();
}
