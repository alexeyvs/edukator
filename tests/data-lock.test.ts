import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Иначе после `kill -9` или перезагрузки каталог оставался бы заперт до
  // ручного `rm`, а сервер молча не поднимался бы.
  it('перехватывает замок мёртвого чужого владельца', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      dataLockPath(dataDir),
      JSON.stringify({ pid: 4242, owner: 'сервер', since: '2026-08-01T00:00:00.000Z', nonce: 'aa' }),
      { flag: 'wx' },
    );

    const lock = acquireDataLock(dataDir, 'prefetch', { alive: () => false });

    expect(holder()).toMatchObject({ pid: process.pid, owner: 'prefetch' });
    lock.release();
  });

  // Обрыв между созданием файла и записью в него оставляет замок без владельца.
  // Проверить его нечем, и вечно запертый каталог хуже перехвата.
  it('перехватывает замок с нечитаемой записью', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dataLockPath(dataDir), 'не json', { flag: 'wx' });

    const lock = acquireDataLock(dataDir, 'сервер', {
      alive: (): boolean => {
        throw new Error('живость нечитаемого владельца не спрашивается');
      },
    });

    expect(holder()).toMatchObject({ owner: 'сервер' });
    lock.release();
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
