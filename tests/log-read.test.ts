import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ADMIN_LOG_PAGE,
  LOGS_DIR,
  LOG_TAIL_BYTES,
  isLogEvent,
  logFilePath,
  readFailureLog,
  readFailureTail,
  rotatedLogPath,
  type LogEntry,
} from '../server/log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-log-read-'));
  mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Строка журнала с заданной отметкой. */
function line(entry: Partial<LogEntry> & { at: string }): string {
  return `${JSON.stringify({
    event: 'server-error',
    message: 'беда',
    ...entry,
  })}\n`;
}

/** Пишет строки в текущий файл журнала, минуя `logFailure`. */
function write(text: string, path: string = logFilePath(dir)): void {
  writeFileSync(path, text);
}

describe('чтение журнала аварий', () => {
  it('читает записи текущего файла от старых к новым', () => {
    write(
      line({ at: '2026-08-21T09:00:00.000Z', message: 'первая' })
      + line({ at: '2026-08-21T09:00:01.000Z', message: 'вторая' }),
    );
    expect(readFailureTail(dir).map((entry) => entry.message)).toEqual(['первая', 'вторая']);
  });

  it('пустой и отсутствующий журнал дают пустой список', () => {
    expect(readFailureTail(dir)).toEqual([]);
    write('');
    expect(readFailureTail(dir)).toEqual([]);
  });

  it('читает только хвост и выбрасывает оборванную срезом первую строку', () => {
    // Хвост первой строки сам по себе — законная запись: не выброси её чтение,
    // на экран приехала бы правдоподобная строка с потерянным началом, а не
    // явный мусор, и заметить подмену было бы нечем.
    const tail = '{"at":"2026-08-21T09:00:00.000Z","event":"server-error","message":"обрубок"}';
    const first = `{"at":"2026-08-21T08:59:59.000Z","event":"server-error","message":"начало ${tail}"}\n`;
    const second = line({ at: '2026-08-21T09:00:01.000Z', message: 'свежая' });
    write(first + second);
    const budget = Buffer.byteLength(second) + Buffer.byteLength(tail) + 1;
    const entries = readFailureTail(dir, budget);
    expect(entries.map((entry) => entry.message)).toEqual(['свежая']);
  });

  it('не теряет запись, когда срез лёг ровно на границу строк', () => {
    const first = line({ at: '2026-08-21T09:00:00.000Z', message: 'старая' });
    const second = line({ at: '2026-08-21T09:00:01.000Z', message: 'ровно с начала' });
    write(first + second);
    // Бюджет ровно в длину второй строки: срез приходится на перевод строки, и
    // выбрасывать здесь нечего — вторая запись цела.
    const entries = readFailureTail(dir, Buffer.byteLength(second));
    expect(entries.map((entry) => entry.message)).toEqual(['ровно с начала']);
  });

  it('битая строка не закрывает соседние', () => {
    write(
      line({ at: '2026-08-21T09:00:00.000Z', message: 'до' })
      + '{это не json\n'
      + '{"at":"2026-08-21T09:00:01.000Z","event":"выдуманное","message":"м"}\n'
      + '{"at":"2026-08-21T09:00:02.000Z","event":"server-error"}\n'
      + line({ at: '2026-08-21T09:00:03.000Z', message: 'после' }),
    );
    expect(readFailureTail(dir).map((entry) => entry.message)).toEqual(['до', 'после']);
  });

  it('добирает предыдущий файл ротации, когда текущего не хватило', () => {
    const older = line({ at: '2026-08-21T08:00:00.000Z', message: 'из архива' });
    write(older, rotatedLogPath(1, dir));
    write(line({ at: '2026-08-21T09:00:00.000Z', message: 'из текущего' }));
    const entries = readFailureTail(dir, 4096);
    expect(entries.map((entry) => entry.message)).toEqual(['из архива', 'из текущего']);
  });

  it('не заходит в архив, когда бюджет выбран текущим файлом', () => {
    write(line({ at: '2026-08-21T08:00:00.000Z', message: 'из архива' }), rotatedLogPath(1, dir));
    const current = line({ at: '2026-08-21T09:00:00.000Z', message: 'из текущего' });
    write(current);
    const entries = readFailureTail(dir, Buffer.byteLength(current));
    expect(entries.map((entry) => entry.message)).toEqual(['из текущего']);
  });

  it('целиком файл в память не читает: за бюджет прочитанное не выходит', () => {
    const padding = 'п'.repeat(1000);
    for (let index = 0; index < 200; index += 1) {
      appendFileSync(
        logFilePath(dir),
        line({ at: `2026-08-21T09:00:${String(index % 60).padStart(2, '0')}.000Z`, detail: padding }),
      );
    }
    // Бюджет вдвое меньше файла — значит и записей приезжает заметно меньше.
    const entries = readFailureTail(dir, 100 * 1024);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(200);
  });
});

describe('страница журнала', () => {
  /** Двадцать записей, чередующих событие и ребёнка. */
  function seed(): void {
    let text = '';
    for (let index = 0; index < 20; index += 1) {
      text += line({
        at: `2026-08-21T09:00:${String(index).padStart(2, '0')}.000Z`,
        event: index % 2 === 0 ? 'server-error' : 'tenant-open-failed',
        message: `запись ${index}`,
        ...(index % 4 === 0 ? { childId: 'abcdef01' } : {}),
      });
    }
    write(text);
  }

  it('отдаёт новые сверху', () => {
    seed();
    const page = readFailureLog(dir, { limit: 3 });
    expect(page.entries.map((entry) => entry.message)).toEqual([
      'запись 19',
      'запись 18',
      'запись 17',
    ]);
  });

  it('фильтрует по событию и по ребёнку', () => {
    seed();
    const byEvent = readFailureLog(dir, { event: 'tenant-open-failed' });
    expect(byEvent.entries).toHaveLength(10);
    expect(byEvent.entries.every((entry) => entry.event === 'tenant-open-failed')).toBe(true);

    const byChild = readFailureLog(dir, { childId: 'abcdef01' });
    expect(byChild.entries.map((entry) => entry.message)).toEqual([
      'запись 16',
      'запись 12',
      'запись 8',
      'запись 4',
      'запись 0',
    ]);

    expect(readFailureLog(dir, { childId: 'нет-такого' }).entries).toEqual([]);
  });

  it('ведёт по курсору `before` без пропусков и повторов', () => {
    seed();
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const current: { entries: LogEntry[]; nextBefore?: string } = readFailureLog(dir, {
        limit: 7,
        ...(before === undefined ? {} : { before }),
      });
      seen.push(...current.entries.map((entry) => entry.message));
      if (current.nextBefore === undefined) break;
      before = current.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => `запись ${19 - index}`));
  });

  it('курсор не теряет записи с одинаковой отметкой', () => {
    const at = '2026-08-21T09:00:00.000Z';
    write(
      line({ at, message: 'первая' })
      + line({ at, message: 'вторая' })
      + line({ at, message: 'третья' }),
    );
    const first = readFailureLog(dir, { limit: 2 });
    expect(first.entries.map((entry) => entry.message)).toEqual(['третья', 'вторая']);
    expect(first.nextBefore).toBeDefined();
    const second = readFailureLog(dir, { limit: 2, before: first.nextBefore ?? '' });
    expect(second.entries.map((entry) => entry.message)).toEqual(['первая']);
    expect(second.nextBefore).toBeUndefined();
  });

  it('курсор без числа понимается как отметка времени', () => {
    seed();
    const page = readFailureLog(dir, { limit: 2, before: '2026-08-21T09:00:05.000Z' });
    expect(page.entries.map((entry) => entry.message)).toEqual(['запись 5', 'запись 4']);
  });

  it('переходит курсором через границу файлов ротации', () => {
    write(
      line({ at: '2026-08-21T08:00:00.000Z', message: 'архив 0' })
      + line({ at: '2026-08-21T08:00:01.000Z', message: 'архив 1' }),
      rotatedLogPath(1, dir),
    );
    write(line({ at: '2026-08-21T09:00:00.000Z', message: 'текущая' }));
    const first = readFailureLog(dir, { limit: 2 });
    expect(first.entries.map((entry) => entry.message)).toEqual(['текущая', 'архив 1']);
    const second = readFailureLog(dir, { limit: 2, before: first.nextBefore ?? '' });
    expect(second.entries.map((entry) => entry.message)).toEqual(['архив 0']);
    expect(second.nextBefore).toBeUndefined();
  });

  it('на пустом журнале страницы нет и курсора нет', () => {
    expect(readFailureLog(dir, {})).toEqual({ entries: [] });
  });

  it('узнаёт события списка и не узнаёт чужие', () => {
    expect(isLogEvent('server-error')).toBe(true);
    expect(isLogEvent('tenant-detached')).toBe(true);
    expect(isLogEvent('всё пропало')).toBe(false);
  });

  it('держит калибровочные константы спеки: хвост и страница', () => {
    expect(LOG_TAIL_BYTES).toBe(524288);
    expect(ADMIN_LOG_PAGE).toBe(200);
  });
});
