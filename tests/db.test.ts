import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  DEFAULT_PROFILE,
  SCHEMA_VERSION,
  TABLES,
  databasePath,
  openDatabase,
  readProfile,
  writeProfile,
} from '../server/db.js';

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
