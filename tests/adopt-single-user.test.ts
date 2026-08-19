import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  childDatabasePath,
  createChild,
  createParent,
  disableParent,
  findParentByEmail,
  listChildren,
  openControlDatabase,
  readChild,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { dataLockPath, SERVER_LOCK_OWNER } from '../server/data-lock.js';
import { openDatabase, readProfile, writeProfile } from '../server/db.js';
import { adoptSingleUser, legacyDatabasePath, parseArgs } from '../scripts/adopt-single-user.js';

const NOW = new Date('2026-08-19T10:00:00.000Z');

describe('перенос однопользовательской базы', () => {
  let dir: string;
  let dataDir: string;
  let source: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-adopt-'));
    dataDir = join(dir, 'данные');
    source = join(dir, 'edukator.db');
    ensureDataDir(dataDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Прежняя база с прогрессом: профиль, состояние темы, забег и ответ. */
  function seedLegacy(): { topic: string; runId: number } {
    const db = openDatabase(source);
    try {
      writeProfile(db, {
        name: 'Тимофей',
        interests: ['шахматы', 'динозавры'],
        partnerName: 'Напарник',
      });
      const topic = 'math-fractions';
      db.prepare(
        `INSERT INTO topic_state (topic_id, mastery, confidence, attempts)
         VALUES (?, 0.42, 0.6, 7)`,
      ).run(topic);
      const run = db
        .prepare(
          `INSERT INTO runs (kind, subject, topic_id, started_at, total, correct)
           VALUES ('run', 'math', ?, ?, 5, 4) RETURNING id`,
        )
        .get(topic, NOW.toISOString()) as { id: number };
      return { topic, runId: run.id };
    } finally {
      db.close();
    }
  }

  function adopt(options: Partial<Parameters<typeof adoptSingleUser>[0]> = {}) {
    return adoptSingleUser({
      email: 'mama@example.com',
      name: 'Тимофей',
      source,
      dataDir,
      log: () => undefined,
      now: () => NOW,
      ...options,
    });
  }

  function openControl(): Database {
    return openControlDatabase(controlDatabasePath(dataDir), { fileMustExist: true });
  }

  it('переносит прогресс целиком и не трогает оригинал', () => {
    const { topic, runId } = seedLegacy();
    const before = readFileSync(source);

    const result = adopt();

    expect(result.parentCreated).toBe(true);
    expect(result.childCreated).toBe(true);
    expect(result.path).toBe(childDatabasePath(dataDir, result.childId));

    const child = openDatabase(result.path, { fileMustExist: true });
    try {
      expect(readProfile(child)).toMatchObject({
        name: 'Тимофей',
        interests: ['шахматы', 'динозавры'],
      });
      expect(
        child
          .prepare<[string], { mastery: number; confidence: number; attempts: number }>(
            'SELECT mastery, confidence, attempts FROM topic_state WHERE topic_id = ?',
          )
          .get(topic),
      ).toEqual({ mastery: 0.42, confidence: 0.6, attempts: 7 });
      expect(child.prepare<[number], { total: number }>('SELECT total FROM runs WHERE id = ?')
        .get(runId)?.total).toBe(5);
    } finally {
      child.close();
    }

    // Оригинал — единственный откат, пока перенос не проверен живым занятием.
    expect(readFileSync(source).equals(before)).toBe(true);
  });

  it('заводит родителя и ребёнка и доводит его до ready', () => {
    seedLegacy();

    const result = adopt();

    const control = openControl();
    try {
      expect(findParentByEmail(control, 'mama@example.com')).toMatchObject({
        id: result.parentId,
        hasPassword: false,
      });
      expect(readChild(control, result.childId)).toMatchObject({
        name: 'Тимофей',
        status: 'ready',
        parentId: result.parentId,
      });
    } finally {
      control.close();
    }
  });

  it('переиспользует заведённого родителя, а не заводит второго', () => {
    seedLegacy();
    const control = openControlDatabase(controlDatabasePath(dataDir));
    const parentId = createParent(control, 'Mama@Example.COM', NOW);
    control.close();

    const result = adopt();

    expect(result.parentId).toBe(parentId);
    expect(result.parentCreated).toBe(false);
    const reopened = openControl();
    try {
      expect(reopened.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM parents')
        .get()?.count).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it('отказывается переносить второй раз поверх готового ребёнка', () => {
    seedLegacy();
    const first = adopt();

    // Повтор затёр бы вчерашним снимком прогресс, набранный уже в новой базе.
    expect(() => adopt()).toThrow(/уже перенесён/u);

    const control = openControl();
    try {
      expect(listChildren(control, first.parentId).map((child) => child.id)).toEqual([first.childId]);
    } finally {
      control.close();
    }
  });

  it('продолжает прерванный перенос тем же ребёнком', () => {
    seedLegacy();
    // Первый заход обрывается на копировании: база испорчена, ребёнок остаётся
    // заведённым и негодным. Отказ повторного запуска здесь сделал бы перенос
    // невосстановимым.
    const broken = join(dir, 'битая.db');
    writeFileSync(broken, 'это не SQLite');
    expect(() => adopt({ source: broken })).toThrow();

    const control = openControl();
    const started = listChildren(control, findParentByEmail(control, 'mama@example.com')?.id ?? '');
    expect(started).toHaveLength(1);
    expect(started[0]?.status).toBe('failed');
    control.close();

    const result = adopt();

    expect(result.childId).toBe(started[0]?.id);
    expect(result.childCreated).toBe(false);
    const reopened = openControl();
    try {
      expect(readChild(reopened, result.childId)?.status).toBe('ready');
    } finally {
      reopened.close();
    }
    expect(existsSync(childDatabasePath(dataDir, result.childId))).toBe(true);
  });

  it('продолжает перенос ребёнка, заведённого без базы', () => {
    seedLegacy();
    const control = openControlDatabase(controlDatabasePath(dataDir));
    const parentId = createParent(control, 'mama@example.com', NOW);
    const childId = createChild(control, parentId, 'Тимофей', NOW);
    control.close();

    const result = adopt();

    expect(result.childId).toBe(childId);
    expect(result.childCreated).toBe(false);
    const child = openDatabase(result.path, { fileMustExist: true });
    try {
      expect(readProfile(child).name).toBe('Тимофей');
    } finally {
      child.close();
    }
  });

  it('отказывается переносить несуществующую базу', () => {
    expect(() => adopt({ source: join(dir, 'нет.db') })).toThrow(/переносить нечего/u);
    // Отказ до первой записи: управляющая база даже не заводится, так что
    // после него нет ни родителя, ни ребёнка, ни файла на их месте.
    expect(existsSync(controlDatabasePath(dataDir))).toBe(false);
  });

  it('отказывается заводить ребёнка отключённому родителю', () => {
    seedLegacy();
    const control = openControlDatabase(controlDatabasePath(dataDir));
    const parentId = createParent(control, 'mama@example.com', NOW);
    disableParent(control, parentId, NOW);
    control.close();

    expect(() => adopt()).toThrow(/отключён/u);
  });

  it('отказывается работать при занятом каталоге данных', () => {
    seedLegacy();
    // Живой сервер успел бы открыть базу ребёнка между `rename` и переводом в
    // `ready` — то есть ту, которую перенос ещё собирает.
    //
    // Замок пишется файлом, а не `acquireDataLock`: взятый этим же процессом
    // считается ссылками и перенос спокойно взял бы его вторым. Владельцем
    // назначается родительский процесс — он заведомо жив, иначе замок сочли бы
    // пережившим владельца и сняли.
    const lockPath = dataLockPath(dataDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.ppid, owner: SERVER_LOCK_OWNER, since: NOW.toISOString(), nonce: 'чужой' })}\n`,
    );

    try {
      expect(() => adopt()).toThrow(/занят/u);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  describe('разбор аргументов', () => {
    it('читает адрес, имя, источник и каталог данных', () => {
      expect(parseArgs([
        '--email', 'mama@example.com',
        '--name', 'Тимофей',
        '--from', 'старая.db',
        '--data-dir', 'данные',
      ])).toEqual({
        email: 'mama@example.com',
        name: 'Тимофей',
        source: resolve('старая.db'),
        dataDir: resolve('данные'),
      });
      expect(parseArgs(['--email', 'mama@example.com', '--name', 'Тимофей'])).toEqual({
        email: 'mama@example.com',
        name: 'Тимофей',
      });
    });

    it('отвергает пустое, повторное, неизвестное и отсутствующее', () => {
      expect(() => parseArgs(['--name', 'Тимофей'])).toThrow(/--email/u);
      expect(() => parseArgs(['--email', 'mama@example.com'])).toThrow(/--name/u);
      expect(() => parseArgs(['--email'])).toThrow(/нет значения/u);
      expect(() => parseArgs(['--email', ' ', '--name', 'Тимофей'])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['--email', 'a@b.ru', '--email', 'c@d.ru'])).toThrow(/дважды/u);
      expect(() => parseArgs(['--куда', 'x'])).toThrow(/Неизвестный флаг/u);
      expect(() => parseArgs(['mama@example.com'])).toThrow(/Непонятный аргумент/u);
    });
  });

  describe('прежний путь базы', () => {
    it('берёт EDUKATOR_DB, а пустое значение считает незаданным', () => {
      expect(legacyDatabasePath('/tmp/старая.db')).toBe('/tmp/старая.db');
      // Пустая строка уходила бы в `resolve` и давала каталог запуска.
      expect(legacyDatabasePath('')).toBe(legacyDatabasePath(undefined));
      expect(legacyDatabasePath(undefined).endsWith('edukator.db')).toBe(true);
    });
  });
});
