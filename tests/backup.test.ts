import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
import { openDatabase, SCHEMA_VERSION, validateSchema, writeProfile } from '../server/db.js';
// Обход каталога данных живёт в скрипте (`scripts/backup.ts`), а примитив
// снятия — в `server/backup.ts`. Оба проверяются здесь: разводить их по двум
// файлам с одинаковым именем нечем.
import { backupDataDir, parseArgs } from '../scripts/backup.js';

const projectRoot = resolve(import.meta.dirname, '..');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

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

  it('не сливает журнал оригинала: спутники `-wal` остаются на месте', () => {
    const source = childDatabase();
    // Соединение помощника закрывается: пока живо хоть одно чужое, слить журнал
    // не может и обычное соединение бэкапа — проверка была бы зелёной и без
    // `readonly`.
    opened.pop()?.close();
    // Журнал, переживший своего писателя. Закрыть соединение здесь нельзя —
    // закрытие само сливает `-wal` в базу, — поэтому пишет и умирает по SIGKILL
    // отдельный процесс: ровно то состояние, ради которого копию и снимают.
    const killed = spawnSync(
      process.execPath,
      [
        '-e',
        "const D = require('better-sqlite3');"
          + 'const db = new D(process.argv[1]);'
          + "db.prepare('UPDATE profile SET interests = ?').run(JSON.stringify(['физика']));"
          + "process.kill(process.pid, 'SIGKILL');",
        source,
      ],
      { stdio: 'ignore' },
    );
    expect(killed.signal).toBe('SIGKILL');
    expect(existsSync(`${source}-wal`)).toBe(true);
    const wal = readFileSync(`${source}-wal`);
    const before = readFileSync(source);

    backupDatabase(source, join(dir, 'копия-с-журналом.db'), { verify: validateSchema });

    // Обычное (не `readonly`) соединение бэкапа закрылось бы здесь последним,
    // слило бы журнал в основной файл и убрало спутники: снятие копии меняло бы
    // оригинал, а `npm run adopt` при этом обещает, что оригинал не тронут.
    expect(existsSync(`${source}-wal`)).toBe(true);
    expect(readFileSync(`${source}-wal`).equals(wal)).toBe(true);
    expect(readFileSync(source).equals(before)).toBe(true);

    // И при этом в копии лежит то, что оставалось только в журнале.
    const copy = openDatabase(join(dir, 'копия-с-журналом.db'), { fileMustExist: true });
    opened.push(copy);
    expect(copy.prepare<[], { interests: string }>('SELECT interests FROM profile').get()?.interests)
      .toBe(JSON.stringify(['физика']));
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

  // `provisioning` без файла — это незаконченное заведение, а `ready` без файла
  // — уже потеря. Нулевой код возврата в цепочке `backup && rm -rf прошлая`
  // означал бы, что последнюю целую копию убрали ровно из-за неё.
  it('считает отказом пропавшую базу готового ребёнка, а не незаведённого', () => {
    const healthy = child('Тимофей');
    const lost = child('Ольга');
    rmSync(join(dir, 'children', `${lost}.db`));

    const result = backupDataDir(dir, out);

    expect(result.children.map((copy) => copy.childId)).toEqual([healthy]);
    expect(result.missing).toEqual([]);
    expect(result.failed.map((failure) => failure.childId)).toEqual([lost]);
  });

  it('испорченная база одного ребёнка не отменяет копию остальных', () => {
    const healthy = child('Тимофей');
    const damaged = child('Ольга');
    // Файл на месте, но базой не является: `quick_check` копии его забракует.
    writeFileSync(join(dir, 'children', `${damaged}.db`), 'не база');

    const result = backupDataDir(dir, out);

    expect(result.children.map((copy) => copy.childId)).toEqual([healthy]);
    expect(result.missing).toEqual([]);
    expect(result.failed.map((failure) => failure.childId)).toEqual([damaged]);
    // Здоровая копия обязана доехать: испорченная база — ровно тот случай,
    // когда копии остальных нужны сильнее всего.
    expect(existsSync(join(out, 'children', `${healthy}.db`))).toBe(true);
  });

  it('снимает копию ребёнка, который ещё не догнал схему приложения', () => {
    const healthy = child('Тимофей');
    const behind = child('Ольга');
    // Детские базы мигрируются лениво, по первому обращению реестра. Сразу
    // после обновления приложения ребёнок, который с тех пор не занимался,
    // законно лежит со схемой прошлой версии — а копия снимается **без**
    // миграции. Забраковав такой снимок, `backup` дал бы код 1 на исправной
    // копии, то есть в цепочке `backup && rm -rf прошлая` убрал бы последнюю
    // целую из-за новой.
    const old = openDatabase(childDatabasePath(dir, behind), { fileMustExist: true });
    try {
      // Именно та база, какой она была до обновления: таблицы последней
      // миграции нет, и версия названа прошлой.
      old.exec('DROP TABLE computer_access_override');
      old.pragma(`user_version = ${String(SCHEMA_VERSION - 1)}`);
    } finally {
      old.close();
    }

    const result = backupDataDir(dir, out);

    expect(result.failed).toEqual([]);
    expect(result.children.map((copy) => copy.childId).sort()).toEqual([healthy, behind].sort());
    // Версия копии осталась прежней: снимок снимают до обновления, а не после.
    const copy = new BetterSqlite3(childDatabasePath(out, behind), {
      fileMustExist: true,
      readonly: true,
    });
    try {
      expect(copy.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION - 1);
      expect(copy.prepare<[], { name: string }>('SELECT name FROM profile').get()?.name)
        .toBe('Ольга');
    } finally {
      copy.close();
    }
  });

  it('всё же бракует копию своей версии с недостающей таблицей', () => {
    const broken = child('Ольга');
    // Версия нынешняя, а таблицы нет: это уже не «схема отстала», а порча,
    // и молчаливая копия такой базы означала бы копию без прогресса.
    const db = openDatabase(childDatabasePath(dir, broken), { fileMustExist: true });
    try {
      db.exec('DROP TABLE attempts');
    } finally {
      db.close();
    }

    const result = backupDataDir(dir, out);

    expect(result.children).toEqual([]);
    expect(result.failed.map((failure) => failure.childId)).toEqual([broken]);
  });

  it('не мигрирует и не переводит в WAL копию управляющей базы', () => {
    child('Тимофей');
    const result = backupDataDir(dir, out);

    // Снимок снимают перед обновлением: `openControlDatabase` на копии включил
    // бы WAL (это запись) и прогнал бы миграцию, то есть откатываться было бы
    // уже некуда.
    const copy = new BetterSqlite3(result.control, { fileMustExist: true, readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    } finally {
      copy.close();
    }
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

  it('пишет неснятую копию ребёнка в журнал аварий каталога данных', () => {
    const healthy = child('Тимофей');
    const damaged = child('Ольга');
    writeFileSync(join(dir, 'children', `${damaged}.db`), 'не база');
    control.close();

    // Скрипт целиком, а не `backupDataDir`: копию снимают из cron, и её отказ
    // не видит никто. Без записи экран аварий молчал бы ровно про то состояние,
    // ради которого копии и снимают, — а молчание там читается как «в порядке».
    const backupCli = resolve(projectRoot, 'scripts', 'backup.ts');
    const result = spawnSync(process.execPath, [tsxCli, backupCli, '--out', out, '--data-dir', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });

    expect(result.status).toBe(1);
    // Журнал лежит в исходном каталоге, а не в каталоге копии: копию уносят с
    // машины, и запись о её неполноте уехала бы вместе с ней.
    const journal = readFileSync(join(dir, 'logs', 'app.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { event: string; childId?: string });
    expect(journal.map((entry) => entry.event)).toEqual(['backup-failed']);
    expect(journal[0]?.childId).toBe(damaged);
    expect(existsSync(join(out, 'children', `${healthy}.db`))).toBe(true);
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
