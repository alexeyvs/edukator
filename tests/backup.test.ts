import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from '../server/backup.js';
import {
  childDatabasePath,
  createChild,
  createParent,
  openControlDatabase,
  retireChild,
  validateControlSchema,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { openDatabase, validateSchema, writeProfile } from '../server/db.js';
// Обход каталога данных живёт в скрипте (`scripts/backup.ts`), а примитив
// снятия — в `server/backup.ts`. Оба проверяются здесь: разводить их по двум
// файлам с одинаковым именем нечем.
import { backupDataDir, parseArgs } from '../scripts/backup.js';

describe('снятие копии базы', () => {
  let dir: string;
  const opened: Database[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-backup-'));
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

  /** Детская база с профилем: по нему видно, доехали ли данные. */
  function childDatabase(name = 'Тимофей'): string {
    const path = join(dir, 'дитя.db');
    const db = openDatabase(path);
    opened.push(db);
    writeProfile(db, { name, interests: ['шахматы'], partnerName: 'Напарник' });
    return path;
  }

  it('копия открывается, проходит validateSchema и содержит данные', () => {
    const source = childDatabase();
    const target = join(dir, 'копии', 'дитя.db');

    backupDatabase(source, target, { verify: validateSchema });

    expect(existsSync(target)).toBe(true);
    const copy = openDatabase(target, { fileMustExist: true });
    opened.push(copy);
    expect(() => {
      validateSchema(copy);
    }).not.toThrow();
    expect(copy.prepare<[], { name: string }>('SELECT name FROM profile').get()?.name)
      .toBe('Тимофей');
  });

  it('уносит записи, оставшиеся в незакрытом WAL', () => {
    const source = childDatabase();
    const live = openDatabase(source, { fileMustExist: true });
    opened.push(live);
    // Соединение намеренно не закрывается и не делает checkpoint: под WAL эта
    // запись лежит в спутнике `-wal`, и `cp` одного файла базы её потерял бы.
    writeProfile(live, { name: 'Тимофей', interests: ['биология'], partnerName: 'Напарник' });
    expect(existsSync(`${source}-wal`)).toBe(true);

    const target = join(dir, 'после-wal.db');
    backupDatabase(source, target, { verify: validateSchema });

    const copy = openDatabase(target, { fileMustExist: true });
    opened.push(copy);
    expect(copy.prepare<[], { interests: string }>('SELECT interests FROM profile').get()?.interests)
      .toBe(JSON.stringify(['биология']));
  });

  it('оригинал остаётся нетронутым', () => {
    const source = childDatabase();
    const live = openDatabase(source, { fileMustExist: true });
    opened.push(live);
    writeProfile(live, { name: 'Тимофей', interests: ['химия'], partnerName: 'Напарник' });
    live.close();
    const before = readFileSync(source);

    backupDatabase(join(dir, 'дитя.db'), join(dir, 'копия.db'), { verify: validateSchema });

    expect(readFileSync(source).equals(before)).toBe(true);
    const reopened = openDatabase(source, { fileMustExist: true });
    opened.push(reopened);
    expect(reopened.prepare<[], { interests: string }>('SELECT interests FROM profile').get()?.interests)
      .toBe(JSON.stringify(['химия']));
  });

  it('снимает копию управляющей базы и проверяет её схему', () => {
    const source = join(dir, 'control.db');
    const control = openControlDatabase(source);
    opened.push(control);
    const parentId = createParent(control, 'mama@example.com');

    const target = join(dir, 'копии', 'control.db');
    backupDatabase(source, target, { verify: validateControlSchema });

    const copy = openControlDatabase(target, { fileMustExist: true });
    opened.push(copy);
    expect(copy.prepare<[string], { email: string }>('SELECT email FROM parents WHERE id = ?')
      .get(parentId)?.email).toBe('mama@example.com');
  });

  it('не перезаписывает существующий файл', () => {
    const source = childDatabase();
    const target = join(dir, 'вчерашняя.db');
    writeFileSync(target, 'вчерашняя копия');

    // Молча заменённая вчерашняя копия ничем не отличается от её отсутствия.
    expect(() => {
      backupDatabase(source, target);
    }).toThrow(/уже есть/u);
    expect(readFileSync(target, 'utf8')).toBe('вчерашняя копия');
  });

  it('отказывается копировать несуществующую базу', () => {
    expect(() => {
      backupDatabase(join(dir, 'нет.db'), join(dir, 'копия.db'));
    }).toThrow(/копировать нечего/u);
    expect(existsSync(join(dir, 'копия.db'))).toBe(false);
  });

  it('отказывается копировать не базу', () => {
    const source = join(dir, 'мусор.db');
    writeFileSync(source, 'это не SQLite');

    expect(() => {
      backupDatabase(source, join(dir, 'копия.db'));
    }).toThrow();
  });

  it('несовпадение схемы краснит снятие, а не остаётся в копии молча', () => {
    // Проверка схемы обязана быть частью снятия: копия, которую нельзя
    // развернуть, обнаруживается иначе только в день восстановления.
    const source = join(dir, 'чужая.db');
    const foreign = new BetterSqlite3(source);
    opened.push(foreign);
    foreign.exec('CREATE TABLE чужая (id INTEGER PRIMARY KEY)');
    foreign.close();

    expect(() => {
      backupDatabase(source, join(dir, 'копия.db'), { verify: validateSchema });
    }).toThrow(/Схема базы повреждена/u);
    // Файл при этом остаётся: разбираться с ним человеку, а молча убранная
    // копия скрыла бы причину отказа.
    expect(statSync(join(dir, 'копия.db')).size).toBeGreaterThan(0);
  });
});

describe('снятие копии каталога данных', () => {
  let dir: string;
  let out: string;
  let control: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-backup-dir-'));
    out = join(dir, 'копия');
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
  });

  afterEach(() => {
    try {
      control.close();
    } catch {
      // База могла быть закрыта самим тестом.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Ребёнок с заведённой базой и профилем: по нему видно, доехали ли данные. */
  function child(name: string): string {
    const parentId = createParent(control, `${name}@example.com`);
    const childId = createChild(control, parentId, name);
    provisionChildDatabase(control, childId, dir);
    const db = openDatabase(childDatabasePath(dir, childId), { fileMustExist: true });
    try {
      writeProfile(db, { name, interests: ['шахматы'], partnerName: 'Напарник' });
    } finally {
      db.close();
    }
    return childId;
  }

  it('снимает управляющую базу и базу каждого ребёнка в тот же вид', () => {
    const first = child('Тимофей');
    const second = child('Ольга');

    const result = backupDataDir(dir, out);

    expect(result.control).toBe(join(out, 'control.db'));
    expect(result.children.map((copy) => copy.childId).sort()).toEqual([first, second].sort());
    expect(result.missing).toEqual([]);

    // Разворачивание — это перенос каталога, поэтому вид копии совпадает.
    for (const copy of result.children) {
      expect(copy.path).toBe(childDatabasePath(out, copy.childId));
      const db = openDatabase(copy.path, { fileMustExist: true });
      try {
        expect(db.prepare<[], { name: string }>('SELECT name FROM profile').get()?.name)
          .toBe(copy.childId === first ? 'Тимофей' : 'Ольга');
      } finally {
        db.close();
      }
    }

    const copiedControl = openControlDatabase(result.control, { fileMustExist: true });
    try {
      expect(copiedControl.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM children')
        .get()?.count).toBe(2);
    } finally {
      copiedControl.close();
    }
  });

  it('снимает и выведенного ребёнка: retired_at не удаляет прогресс', () => {
    const childId = child('Тимофей');
    retireChild(control, childId);

    const result = backupDataDir(dir, out);

    expect(result.children.map((copy) => copy.childId)).toEqual([childId]);
  });

  it('называет детей без базы вместо того, чтобы считать копию полной', () => {
    const withDatabase = child('Тимофей');
    const parentId = createParent(control, 'papa@example.com');
    // Заведение сорвалось: строка есть, файла нет.
    const broken = createChild(control, parentId, 'Ольга');

    const result = backupDataDir(dir, out);

    expect(result.children.map((copy) => copy.childId)).toEqual([withDatabase]);
    expect(result.missing).toEqual([broken]);
  });

  it('отказывается писать в каталог, где копия уже лежит', () => {
    child('Тимофей');
    backupDataDir(dir, out);

    // Второй прогон в тот же каталог обязан упасть, а не подменить вчерашнюю
    // копию наполовину сегодняшней.
    expect(() => backupDataDir(dir, out)).toThrow(/уже есть/u);
  });

  it('отказывается снимать копию каталога без управляющей базы', () => {
    const empty = mkdtempSync(join(tmpdir(), 'edukator-backup-empty-'));
    try {
      expect(() => backupDataDir(empty, out)).toThrow(/копировать нечего/u);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  describe('разбор аргументов', () => {
    it('приводит пути к абсолютным', () => {
      expect(parseArgs(['--out', 'копии', '--data-dir', 'данные'])).toEqual({
        outDir: resolve('копии'),
        dataDir: resolve('данные'),
      });
      expect(parseArgs(['--out', out])).toEqual({ outDir: out });
    });

    it('отвергает пустое, повторное, неизвестное и отсутствующее', () => {
      expect(() => parseArgs([])).toThrow(/--out/u);
      expect(() => parseArgs(['--out'])).toThrow(/нет значения/u);
      expect(() => parseArgs(['--out', '  '])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['--out', 'a', '--out', 'b'])).toThrow(/дважды/u);
      expect(() => parseArgs(['--куда', 'a'])).toThrow(/Неизвестный флаг/u);
      expect(() => parseArgs(['копии'])).toThrow(/Непонятный аргумент/u);
    });
  });
});
