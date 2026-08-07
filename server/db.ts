import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * Версия схемы. Хранится в `PRAGMA user_version`; миграция сравнивает её со
 * своей и пропускает работу, если база уже актуальна.
 */
export const SCHEMA_VERSION = 1;

/** Семь таблиц из спеки. Тесты сверяют состав базы именно с этим списком. */
export const TABLES = [
  'profile',
  'topic_state',
  'task_bank',
  'runs',
  'attempts',
  'disputes',
  'forecast_snapshots',
] as const;

/** Предметы подготовки. Ограничение уровня схемы, чтобы опечатка не дошла до отчётов. */
export const SUBJECTS = ['math', 'russian', 'english'] as const;
export type Subject = (typeof SUBJECTS)[number];

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    next_review TEXT
  );

  CREATE TABLE IF NOT EXISTS task_bank (
    id         INTEGER PRIMARY KEY,
    topic_id   TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    question   TEXT    NOT NULL,
    answer     TEXT    NOT NULL,
    accept     TEXT    NOT NULL DEFAULT '[]',
    hint       TEXT,
    explain    TEXT,
    joke       TEXT,
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
    status     TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'valid', 'rejected', 'used')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS task_bank_queue
    ON task_bank (topic_id, status, difficulty);

  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    subject     TEXT    NOT NULL CHECK (subject IN (${subjectCheck})),
    topic_id    TEXT    NOT NULL REFERENCES topic_state (topic_id) ON DELETE CASCADE,
    started_at  TEXT    NOT NULL,
    finished_at TEXT,
    total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
    correct     INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0)
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
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS attempts_by_topic ON attempts (topic_id, created_at);

  CREATE TABLE IF NOT EXISTS disputes (
    id          INTEGER PRIMARY KEY,
    attempt_id  INTEGER NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'upheld', 'rejected')),
    resolution  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS forecast_snapshots (
    id         INTEGER PRIMARY KEY,
    subject    TEXT    NOT NULL CHECK (subject IN (${subjectCheck}, 'overall')),
    score      REAL    NOT NULL CHECK (score BETWEEN 2 AND 5),
    band       REAL    NOT NULL DEFAULT 0 CHECK (band >= 0),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS forecast_by_subject
    ON forecast_snapshots (subject, created_at);
`;

/**
 * Путь к базе: переопределяется через EDUKATOR_DB, чтобы тесты и dev-запуск
 * не дрались за один файл.
 */
export function databasePath(): string {
  return process.env.EDUKATOR_DB ?? resolve(projectRoot, 'edukator.db');
}

/**
 * Приводит базу к текущей версии схемы. Идемпотентна: на уже мигрированной базе
 * ничего не выполняет, данные не трогает. Вся DDL идёт одной транзакцией —
 * оборванная миграция не оставляет половину таблиц.
 */
export function migrate(db: Database.Database): void {
  const [version] = db.pragma('user_version') as [{ user_version: number }];
  if (version.user_version >= SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/**
 * Открывает базу, включает WAL и внешние ключи и мигрирует схему.
 * WAL нужен, чтобы фоновый воркер генерации не блокировал чтение во время забега;
 * внешние ключи в SQLite выключены по умолчанию и включаются на каждом соединении.
 */
export function openDatabase(path: string = databasePath()): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
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
  if (row === undefined) return { ...DEFAULT_PROFILE, interests: [...DEFAULT_PROFILE.interests] };

  return {
    name: row.name,
    interests: parseInterests(row.interests),
    examDate: row.exam_date,
    partnerName: row.partner_name,
  };
}

/**
 * Сохраняет переданные поля профиля поверх текущих (или поверх значений по
 * умолчанию при первом запуске) и возвращает результат целиком.
 */
export function writeProfile(db: Database.Database, patch: Partial<Profile>): Profile {
  if (patch.examDate !== undefined && patch.examDate !== null && !ISO_DATE.test(patch.examDate)) {
    throw new Error(`Некорректная дата экзамена (exam_date): ожидается YYYY-MM-DD, получено «${patch.examDate}»`);
  }

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
}
