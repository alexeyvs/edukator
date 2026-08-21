import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { childDatabasePath } from '../server/control-db.js';
import { ensureDataDir } from '../server/data-dir.js';
import { SCHEMA_VERSION, openDatabase, writeProfile } from '../server/db.js';
import {
  readChildDatabase,
  sweepChildDatabases,
  type ChildDatabaseMeta,
} from '../server/admin/child-readonly.js';

/** Непрозрачные `id` формата `CHILD_ID_PATTERN`: путь считается из них. */
const FIRST = 'a1b2c3d4';
const SECOND = 'b2c3d4e5';
const THIRD = 'c3d4e5f6';

describe('опенер детских баз для отчётов оператора', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-child-readonly-'));
    ensureDataDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Настоящая детская база нынешней схемы с профилем: по нему видно чтение. */
  function childDatabase(childId: string, name: string): string {
    const path = childDatabasePath(dir, childId);
    const db = openDatabase(path);
    try {
      writeProfile(db, { name, interests: ['шахматы'], partnerName: 'Напарник' });
    } finally {
      db.close();
    }
    return path;
  }

  /** База прошлой версии: пустой файл с проставленным `user_version`. */
  function staleDatabase(childId: string, version: number): string {
    const path = childDatabasePath(dir, childId);
    const db = new BetterSqlite3(path);
    try {
      db.exec('CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      db.prepare('INSERT INTO profile (id, name) VALUES (1, ?)').run('Тимофей');
      db.pragma(`user_version = ${version}`);
    } finally {
      db.close();
    }
    return path;
  }

  function readName(): (db: BetterSqlite3.Database) => string {
    return (db) =>
      (db.prepare('SELECT name FROM profile WHERE id = 1').get() as { name: string }).name;
  }

  it('читает исправную базу и закрывает соединение сразу', () => {
    childDatabase(FIRST, 'Тимофей');

    let handle: BetterSqlite3.Database | undefined;
    const result = readChildDatabase(dir, FIRST, (db, meta) => {
      handle = db;
      expect(meta.childId).toBe(FIRST);
      expect(meta.path).toBe(childDatabasePath(dir, FIRST));
      return readName()(db);
    });

    expect(result.state).toBe('read');
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    if (result.state !== 'read') throw new Error('ожидалось прочитанное состояние');
    expect(result.value).toBe('Тимофей');
    // Соединение живёт ровно один запрос: потолок аренд здесь не при чём именно
    // потому, что открытых баз после обхода не остаётся.
    expect(handle?.open).toBe(false);
  });

  it('соединение не даёт писать: отчёт оператора чужую базу не меняет', () => {
    childDatabase(FIRST, 'Тимофей');

    expect(() =>
      readChildDatabase(dir, FIRST, (db) => {
        db.prepare('UPDATE profile SET name = ? WHERE id = 1').run('Кто-то другой');
        return null;
      }),
    ).toThrow(/readonly/iu);
  });

  it('базу со схемой прошлой версии опознаёт и не читает', () => {
    staleDatabase(SECOND, SCHEMA_VERSION - 1);

    let read = false;
    const result = readChildDatabase(dir, SECOND, () => {
      read = true;
      return 'нельзя';
    });

    expect(result.state).toBe('stale');
    expect(result.schemaVersion).toBe(SCHEMA_VERSION - 1);
    // Запросы отчёта по чужой схеме либо не выполнились бы вовсе, либо
    // посчитали бы не то, поэтому читателя тут не зовут вообще.
    expect(read).toBe(false);
  });

  it('базу новее приложения тоже не читает', () => {
    staleDatabase(SECOND, SCHEMA_VERSION + 1);

    const result = readChildDatabase(dir, SECOND, () => 'нельзя');

    expect(result.state).toBe('stale');
    expect(result.schemaVersion).toBe(SCHEMA_VERSION + 1);
  });

  it('не мигрирует: `user_version` и содержимое базы после обхода те же', () => {
    const path = staleDatabase(SECOND, SCHEMA_VERSION - 1);
    const before = readFileSync(path);

    readChildDatabase(dir, SECOND, () => 'нельзя');
    sweepChildDatabases(dir, [SECOND], () => 'нельзя');

    expect(readFileSync(path).equals(before)).toBe(true);
    const db = new BetterSqlite3(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION - 1);
      expect(db.prepare('SELECT name FROM profile WHERE id = 1').get()).toEqual({
        name: 'Тимофей',
      });
    } finally {
      db.close();
    }
  });

  it('пропавшую базу отвергает с именем ребёнка и путём', () => {
    expect(() => readChildDatabase(dir, FIRST, () => null)).toThrow(
      new RegExp(`${FIRST}.*${childDatabasePath(dir, FIRST)}`, 'u'),
    );
  });

  it('чужой формат `id` до открытия файла не доходит', () => {
    expect(() => readChildDatabase(dir, '../control', () => null)).toThrow();
  });

  it('битая база попадает в `failed[]` и не срывает обход остальных', () => {
    childDatabase(FIRST, 'Тимофей');
    writeFileSync(childDatabasePath(dir, SECOND), 'это не база');
    childDatabase(THIRD, 'Марта');

    const sweep = sweepChildDatabases(dir, [FIRST, SECOND, THIRD], readName());

    expect(sweep.reports.map((report) => report.value)).toEqual(['Тимофей', 'Марта']);
    expect(sweep.failed).toHaveLength(1);
    expect(sweep.failed[0]?.childId).toBe(SECOND);
    expect(sweep.failed[0]?.reason).not.toBe('');
    expect(sweep.stale).toEqual([]);
  });

  it('отказ читателя на одном ребёнке не отменяет остальных', () => {
    childDatabase(FIRST, 'Тимофей');
    childDatabase(SECOND, 'Марта');

    const sweep = sweepChildDatabases(dir, [FIRST, SECOND], (db, meta) => {
      if (meta.childId === FIRST) throw new Error('запрос отчёта не выполнился');
      return readName()(db);
    });

    expect(sweep.failed).toEqual([
      { childId: FIRST, reason: 'запрос отчёта не выполнился' },
    ]);
    expect(sweep.reports.map((report) => report.value)).toEqual(['Марта']);
  });

  it('разводит прочитанных, отложенных по схеме и не открывшихся', () => {
    childDatabase(FIRST, 'Тимофей');
    staleDatabase(SECOND, SCHEMA_VERSION - 1);

    const sweep = sweepChildDatabases(dir, [FIRST, SECOND, THIRD], readName());

    expect(sweep.reports).toEqual([
      {
        childId: FIRST,
        path: childDatabasePath(dir, FIRST),
        schemaVersion: SCHEMA_VERSION,
        value: 'Тимофей',
      },
    ]);
    const stale: ChildDatabaseMeta[] = [
      {
        childId: SECOND,
        path: childDatabasePath(dir, SECOND),
        schemaVersion: SCHEMA_VERSION - 1,
      },
    ];
    expect(sweep.stale).toEqual(stale);
    expect(sweep.failed.map((failure) => failure.childId)).toEqual([THIRD]);
  });

  it('порядок обхода сохраняется: он задан вызывающим', () => {
    childDatabase(FIRST, 'Тимофей');
    childDatabase(SECOND, 'Марта');
    childDatabase(THIRD, 'Егор');

    const sweep = sweepChildDatabases(dir, [THIRD, FIRST, SECOND], readName());

    expect(sweep.reports.map((report) => report.value)).toEqual(['Егор', 'Тимофей', 'Марта']);
  });

  it('пустой список детей — пустой отчёт, а не отказ', () => {
    expect(sweepChildDatabases(dir, [], readName())).toEqual({
      reports: [],
      stale: [],
      failed: [],
    });
  });
});
