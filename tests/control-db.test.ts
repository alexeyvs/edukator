import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  CONTROL_SCHEMA_VERSION,
  CONTROL_TABLES,
  migrateControl,
  openControlDatabase,
  validateControlSchema,
} from '../server/control-db.js';

/** Формат, в котором отметки времени пишет код: сравнение по колонке — строковое. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Число открытых процессом дескрипторов. Утечку соединения иначе не увидеть:
 * объект базы наружу не возвращается. На системах без `/dev/fd` отдаёт 0 —
 * проверка вырождается в «не выросло», но не ломается.
 */
function openDescriptors(): number {
  return existsSync('/dev/fd') ? readdirSync('/dev/fd').length : 0;
}

function tableNames(db: Database): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

let dir: string;
let path: string;
const opened: Database[] = [];

function open(): Database {
  const db = openControlDatabase(path);
  opened.push(db);
  return db;
}

/** Родитель нужен почти всем таблицам: на него ссылаются дети, сессии и приглашения. */
function seedParent(db: Database, id = 'p1', email = 'mama@example.com'): string {
  db.prepare('INSERT INTO parents (id, email) VALUES (?, ?)').run(id, email);
  return id;
}

function seedChild(db: Database, parentId: string, id = 'abcdef01'): string {
  db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(id, parentId, 'Сын');
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-control-'));
  path = join(dir, 'control.db');
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // База могла быть закрыта самим тестом.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('openControlDatabase', () => {
  it('создаёт базу с полным составом таблиц и версией схемы', () => {
    const db = open();

    expect(tableNames(db)).toEqual([...CONTROL_TABLES].sort());
    const [version] = db.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(CONTROL_SCHEMA_VERSION);
  });

  it('включает WAL и внешние ключи на соединении', () => {
    const db = open();

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    // Внешний ключ должен именно отказывать, а не оставаться украшением схемы.
    expect(() =>
      db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(
        'abcdef01',
        'нет такого',
        'Сын',
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('повторное открытие идемпотентно и не трогает данные', () => {
    const first = open();
    seedParent(first);
    first.close();

    const second = open();
    expect(tableNames(second)).toEqual([...CONTROL_TABLES].sort());
    const [version] = second.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(CONTROL_SCHEMA_VERSION);
    const parent = second
      .prepare<[], { email: string }>('SELECT email FROM parents')
      .get();
    expect(parent?.email).toBe('mama@example.com');
  });

  it('пишет умолчания отметок времени в ISO', () => {
    const db = open();
    const parentId = seedParent(db);
    seedChild(db, parentId);

    const parent = db.prepare<[], { created_at: string }>('SELECT created_at FROM parents').get();
    const child = db.prepare<[], { created_at: string }>('SELECT created_at FROM children').get();
    expect(parent?.created_at).toMatch(ISO_STAMP);
    expect(child?.created_at).toMatch(ISO_STAMP);
  });

  it('держит константы спеки: номер версии и состав таблиц', () => {
    expect(CONTROL_SCHEMA_VERSION).toBe(1);
    expect([...CONTROL_TABLES]).toEqual([
      'parents',
      'parent_invites',
      'parent_sessions',
      'children',
      'child_devices',
      'codex_quota',
      'login_attempts',
    ]);
  });
});

describe('ограничения схемы', () => {
  it('не принимает `id` ребёнка с разделителем пути или точками', () => {
    const db = open();
    const parentId = seedParent(db);

    for (const bad of ['../secret', 'a/b/c12345', '..', 'ABCDEF01']) {
      expect(() =>
        db
          .prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)')
          .run(bad, parentId, 'Сын'),
      ).toThrow(/CHECK/i);
    }
  });

  it('не принимает email в верхнем регистре и неизвестный статус ребёнка', () => {
    const db = open();
    const parentId = seedParent(db);

    expect(() =>
      db.prepare('INSERT INTO parents (id, email) VALUES (?, ?)').run('p2', 'Papa@Example.com'),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare('INSERT INTO children (id, parent_id, name, status) VALUES (?, ?, ?, ?)')
        .run('abcdef02', parentId, 'Сын', 'active'),
    ).toThrow(/CHECK/i);
  });

  it('не даёт погасить приглашение устройства без выдачи токена', () => {
    const db = open();
    const childId = seedChild(db, seedParent(db));
    const insert = db.prepare(
      `INSERT INTO child_devices (child_id, kind, invite_hash, invite_expires_at, claimed_at, token_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(childId, 'browser', 'hash-1', '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z', null),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run(childId, 'agent', 'hash-2', '2026-08-21T00:00:00.000Z', null, 'token-2'),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run(childId, 'browser', 'hash-3', '2026-08-21T00:00:00.000Z', null, null),
    ).not.toThrow();
  });

  it('держит квоту уникальной по ребёнку и суткам и запрещает отрицательный счётчик', () => {
    const db = open();
    const childId = seedChild(db, seedParent(db));
    const insert = db.prepare('INSERT INTO codex_quota (child_id, day, calls) VALUES (?, ?, ?)');
    insert.run(childId, '2026-08-19', 1);

    expect(() => insert.run(childId, '2026-08-19', 2)).toThrow(/UNIQUE/i);
    expect(() => insert.run(childId, '2026-08-20', -1)).toThrow(/CHECK/i);
  });
});

describe('ошибочные пути', () => {
  it('отвергает базу новее приложения', () => {
    const raw = new BetterSqlite3(path);
    raw.pragma(`user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => open()).toThrow(/более новой версией схемы/);
  });

  it('отвергает базу без версии с посторонним объектом', () => {
    const raw = new BetterSqlite3(path);
    raw.exec('CREATE TABLE stranger (id INTEGER PRIMARY KEY)');
    raw.close();

    expect(() => open()).toThrow(/содержит объект «stranger»/);
  });

  it('не утекает дескриптором при отказе открытия', () => {
    const raw = new BetterSqlite3(path);
    raw.pragma(`user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    raw.close();

    const before = openDescriptors();
    for (let i = 0; i < 10; i += 1) {
      expect(() => openControlDatabase(path)).toThrow();
    }
    expect(openDescriptors()).toBeLessThanOrEqual(before);
  });

  it('отвергает базу с актуальной версией, но потерянной таблицей', () => {
    const db = open();
    db.close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP TABLE login_attempts');
    raw.close();

    expect(() => open()).toThrow(/Схема управляющей базы повреждена/);
  });

  it('отвергает базу с потерянным индексом и с ослабленным ограничением', () => {
    const db = open();
    db.close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP INDEX children_parent');
    raw.close();
    expect(() => open()).toThrow(/отсутствуют children_parent/);

    const relaxed = new BetterSqlite3(join(dir, 'relaxed.db'));
    relaxed.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, pin_hash TEXT,
        credentials_changed_at TEXT, disabled_at TEXT, created_at TEXT);
    `);
    expect(() => validateControlSchema(relaxed)).toThrow(/Схема управляющей базы повреждена/);
    relaxed.close();
  });

  it('не мигрирует базу с неизвестной прошлой версией вслепую', () => {
    const raw = new BetterSqlite3(path);
    raw.exec('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 0');
    raw.close();

    // Версия 0 с чужим объектом — отказ; а версия из будущего прошлого (когда
    // переходы появятся) не должна проходить молча.
    const other = new BetterSqlite3(join(dir, 'other.db'));
    other.pragma(`user_version = ${CONTROL_SCHEMA_VERSION - 1}`);
    if (CONTROL_SCHEMA_VERSION > 1) {
      expect(() => migrateControl(other)).toThrow(/не имеет перехода/);
    }
    other.close();

    expect(() => open()).toThrow(/содержит объект «parents»/);
  });
});
