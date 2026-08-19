import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDataLock,
  DATA_LOCK_FILE,
  DataLockBusyError,
  dataLockPath,
  processAlive,
  type DataLockRecord,
} from '../server/data-lock.js';

describe('замок каталога данных', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-lock-'));
    dataDir = join(tempDir, 'данные');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function holder(): DataLockRecord {
    return JSON.parse(readFileSync(dataLockPath(dataDir), 'utf8')) as DataLockRecord;
  }

  it('заводит каталог и записывает владельца', () => {
    const lock = acquireDataLock(dataDir, 'сервер');

    expect(lock.path).toBe(join(dataDir, DATA_LOCK_FILE));
    expect(holder()).toMatchObject({ pid: process.pid, owner: 'сервер' });
    expect(Date.parse(holder().since)).not.toBeNaN();

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  // Замок въезжает на место дописанным: `open(..., 'wx')` оставлял бы на его
  // месте пустой файл на всё время записи и `fsync`, а пустой замок соседний
  // процесс считает нечитаемым, то есть брошенным, — и снимает с живого.
  it('не показывает пустого замка и не оставляет времянок', () => {
    const lock = acquireDataLock(dataDir, 'сервер');

    expect(readFileSync(lock.path, 'utf8').trim().length).toBeGreaterThan(0);
    expect(holder().nonce.length).toBeGreaterThan(0);
    expect(readdirSync(dataDir)).toEqual([DATA_LOCK_FILE]);

    lock.release();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  // Чужой процесс — единственное, от чего замок защищает: предел вызовов codex
  // живёт в памяти процесса, и вторая пара слотов заводится только вторым.
  it('отказывает чужому живому процессу и называет владельца', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dataLockPath(dataDir),
      JSON.stringify({
        pid: 4242,
        owner: 'сервер',
        since: '2026-08-19T10:00:00.000Z',
        nonce: 'aa',
      }),
      { flag: 'wx' },
    );

    expect(() => acquireDataLock(dataDir, 'prefetch', { alive: () => true }))
      .toThrow(DataLockBusyError);
    // Текст отказа — единственное, что увидит запустивший руками прогрев:
    // «занято» без владельца и времени не подсказывает, что делать дальше.
    expect(() => acquireDataLock(dataDir, 'prefetch', { alive: () => true }))
      .toThrow(/сервер \(pid 4242\) с 2026-08-19T10:00:00/u);
    // Чужой замок остался на месте: отказавший не имеет права его переписать.
    expect(holder()).toMatchObject({ pid: 4242, nonce: 'aa' });
  });

  // Два сервера в одном процессе делят те же два слота codex, так что и замок
  // у них общий; файл уходит с последним из них.
  it('берётся повторно в своём же процессе и снимается последним', () => {
    const first = acquireDataLock(dataDir, 'сервер');
    const second = acquireDataLock(dataDir, 'сервер');

    first.release();
    expect(existsSync(dataLockPath(dataDir))).toBe(true);

    second.release();
    expect(existsSync(dataLockPath(dataDir))).toBe(false);
  });

  it('пускает следующего после снятия замка', () => {
    acquireDataLock(dataDir, 'сервер').release();

    const second = acquireDataLock(dataDir, 'prefetch');

    expect(holder()).toMatchObject({ owner: 'prefetch' });
    second.release();
  });

  it('не перехватывает замок мёртвого владельца неатомарным снятием', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dataLockPath(dataDir),
      JSON.stringify({ pid: 4242, owner: 'сервер', since: '2026-08-01T00:00:00.000Z', nonce: 'aa' }),
      { flag: 'wx' },
    );

    expect(() => acquireDataLock(dataDir, 'prefetch', { alive: () => false }))
      .toThrow(/выглядит брошенным.*удалите/u);
    expect(holder()).toMatchObject({ pid: 4242, owner: 'сервер', nonce: 'aa' });
  });

  it('не снимает замок с повреждённой записью', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dataLockPath(dataDir), 'не json', { flag: 'wx' });

    expect(() => acquireDataLock(dataDir, 'сервер', {
      alive: (): boolean => {
        throw new Error('живость нечитаемого владельца не спрашивается');
      },
    })).toThrow(/выглядит брошенным.*удалите/u);
    expect(readFileSync(dataLockPath(dataDir), 'utf8')).toBe('не json');
  });

  // Нечитаемая **запись** (не json) и нечитаемый **файл** — разные вещи:
  // первую проверить нечем, а второй проверить просто не дали, и разрешить по
  // нему снять чужой живой замок значило бы завести в каталоге второй бюджет
  // codex — ровно то, от чего замок и стоит.
  it('не снимает замок, файл которого не удалось прочитать', () => {
    // Замок чужого процесса: свой этот же вызов вернул бы по счётчику ссылок,
    // не читая файла вовсе.
    mkdirSync(dataDir, { recursive: true });
    const path = dataLockPath(dataDir);
    writeFileSync(
      path,
      JSON.stringify({ pid: 1, owner: 'сервер', since: '2026-08-19T10:00:00.000Z', nonce: 'чужой' }),
      { flag: 'wx' },
    );
    // Права снимаются с самого файла: удалить его каталог позволяет по-прежнему,
    // а прочитать — уже нет. Так же выглядят `EACCES` на чужом файле и `EMFILE`
    // при исчерпанных дескрипторах.
    chmodSync(path, 0o000);
    let readable = true;
    try {
      readFileSync(path, 'utf8');
    } catch {
      readable = false;
    }
    // Под root права не действуют: проверять там нечего.
    if (readable) return;

    // Класс отказа важен не меньше текста: `buildServer` гасит запуск только на
    // `DataLockBusyError`, а всякую другую ошибку считает незаписываемым
    // каталогом и поднимается **без** замка — то есть рядом с живым владельцем,
    // со второй парой слотов codex.
    expect(() => acquireDataLock(dataDir, 'ручной прогрев', {
      alive: (): boolean => {
        throw new Error('живость владельца нечитаемого замка не спрашивается');
      },
    })).toThrow(DataLockBusyError);
    expect(() => acquireDataLock(dataDir, 'ручной прогрев', {
      alive: (): boolean => {
        throw new Error('живость владельца нечитаемого замка не спрашивается');
      },
    })).toThrow(/EACCES/u);
    // И, главное, чужой замок остался на месте: снять его — значит пустить в
    // каталог второй процесс со своей парой слотов codex.
    expect(existsSync(path)).toBe(true);

    chmodSync(path, 0o600);
  });

  // Замок могли убрать руками, а на его место встать другой процесс: снять его
  // на своём закрытии значило бы пустить в каталог третьего.
  it('не снимает чужой замок, вставший на место нашего', () => {
    const lock = acquireDataLock(dataDir, 'сервер');
    rmSync(lock.path);
    writeFileSync(
      lock.path,
      JSON.stringify({ pid: 4242, owner: 'чужой', since: '2026-08-19T10:00:00.000Z', nonce: 'bb' }),
      { flag: 'wx' },
    );

    lock.release();

    expect(holder()).toMatchObject({ owner: 'чужой', nonce: 'bb' });
  });

  it('снимается один раз: повторное снятие ничего не трогает', () => {
    const lock = acquireDataLock(dataDir, 'сервер');
    lock.release();
    const other = acquireDataLock(dataDir, 'prefetch');

    lock.release();

    expect(holder()).toMatchObject({ owner: 'prefetch' });
    other.release();
  });

  it('не снимает забытый замок со своим же номером процесса', () => {
    mkdirSync(dataDir, { recursive: true });
    // Наш собственный pid в файле, о котором процесс уже не помнит, — это
    // брошенный замок: написать его мог только он сам. Считая такой замок
    // чужим и живым (`processAlive(process.pid)` всегда истинно), сервер
    // отказывался бы стартовать на свободном каталоге до ручного `rm`.
    writeFileSync(
      dataLockPath(dataDir),
      JSON.stringify({ pid: process.pid, owner: 'сервер', since: new Date(0).toISOString(), nonce: 'чужой' }),
    );

    expect(() => acquireDataLock(dataDir, 'prefetch')).toThrow(/выглядит брошенным.*удалите/u);
    expect(holder()).toMatchObject({ pid: process.pid, owner: 'сервер', nonce: 'чужой' });
  });

  describe('живость владельца', () => {
    it('считает живым себя и мёртвым несуществующего', () => {
      expect(processAlive(process.pid)).toBe(true);
      // Первый процесс системы существует всегда и принадлежит root: `EPERM`
      // обязан считаться живостью, иначе его замок сняли бы как мёртвый.
      expect(processAlive(1)).toBe(true);
      expect(processAlive(0)).toBe(false);
      expect(processAlive(-1)).toBe(false);
      expect(processAlive(2 ** 30)).toBe(false);
    });
  });
});
