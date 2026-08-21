import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** `user_version` прямо из заголовка файла: тем же способом, что и опенер. */
function headerVersion(path: string): number {
  const handle = openSync(path, 'r');
  try {
    const header = Buffer.alloc(64);
    readSync(handle, header, 0, 64, 0);
    return header.readUInt32BE(60);
  } finally {
    closeSync(handle);
  }
}

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

  it('не заводит спутников рядом с базой не той версии', () => {
    // Детские базы живут под WAL, и соединение к ним — уже прикосновение:
    // рядом появляется `-shm`, убрать который `readonly`-соединению нечем. То
    // есть «не читаем и не трогаем» держалось бы на слове, а размер базы на
    // главном экране оператора (он считает спутники) прыгал бы навсегда от
    // одного захода в статистику.
    const path = childDatabasePath(dir, SECOND);
    const db = new BetterSqlite3(path);
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    } finally {
      db.close();
    }

    const result = readChildDatabase(dir, SECOND, () => 'нельзя');

    expect(result.state).toBe('stale');
    expect(result.schemaVersion).toBe(SCHEMA_VERSION - 1);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it('читает базу, у которой новая версия ещё лежит в WAL', () => {
    // Миграция под WAL кладёт страницу с `user_version` в журнал, а в главный
    // файл её переносит только чекпойнт. Заголовок при этом показывает прежний
    // номер, и ребёнок, чью базу первый заход только что мигрировал, выглядел
    // бы «схема прошлой версии, ждёт первого захода» ровно тогда, когда он за
    // ней и сидит.
    const path = childDatabasePath(dir, FIRST);
    const writer = openDatabase(path);
    try {
      writeProfile(writer, { name: 'Тимофей', interests: [], partnerName: 'Напарник' });
      // Заголовок отстал: настоящий номер знает только движок.
      expect(headerVersion(path)).not.toBe(SCHEMA_VERSION);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

      const result = readChildDatabase(dir, FIRST, readName());

      expect(result.state).toBe('read');
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.state === 'read' ? result.value : '').toBe('Тимофей');
    } finally {
      writer.close();
    }
  });

  it('отложенной по схеме признаёт только базу без непустого WAL', () => {
    // Обратная сторона того же: без журнала рядом заголовку верить можно, и
    // лишнего соединения база не получает.
    const path = staleDatabase(SECOND, SCHEMA_VERSION - 1);
    expect(existsSync(`${path}-wal`)).toBe(false);

    expect(readChildDatabase(dir, SECOND, () => 'нельзя').state).toBe('stale');
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

  it('пропавшую базу отвергает с именем ребёнка, но без пути', () => {
    // Ребёнок назван: без него у `SQLITE_CANTOPEN` не остаётся ничего, по чему
    // жалобу можно узнать. Пути нет: этот текст доезжает до тела HTTP-ответа
    // (`failed[].reason` обоих отчётов оператора), а каталог данных — подробность
    // машины, которой в ответе не место.
    let thrown = '';
    try {
      readChildDatabase(dir, FIRST, () => null);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toContain(FIRST);
    expect(thrown).not.toContain(childDatabasePath(dir, FIRST));
    expect(thrown).not.toContain(dir);
  });

  it('не пересказывает путь и в чужих отказах', () => {
    // Свой текст пути не содержит, но сообщения `node:fs` и драйвера содержат:
    // `EACCES: permission denied, open '/…/children/….db'` уезжает в тело
    // ответа дословно, обходя ровно ту сдержанность, ради которой свой текст и
    // писался.
    const path = childDatabase(FIRST, 'Тимофей');
    chmodSync(path, 0o000);
    try {
      const sweep = sweepChildDatabases(dir, [FIRST], readName());
      expect(sweep.failed).toHaveLength(1);
      const reason = sweep.failed[0]?.reason ?? '';
      expect(reason).not.toBe('');
      expect(reason).not.toContain(path);
      expect(reason).not.toContain(dir);
    } finally {
      chmodSync(path, 0o600);
    }
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
