import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Подстроенная гонка двух писателей: следующая прокрутка застаёт файл уже
 * уехавшим в архив.
 *
 * Писать в журнал могут два процесса сразу — сервер и `scripts/backup.ts`,
 * который замка каталога намеренно не берёт, — и настоящей гонкой это не
 * проверить: она случается на границе в восемь мегабайт и не по расписанию.
 */
const race = vi.hoisted(() => ({
  neighbour: undefined as (() => void) | undefined,
  breakRename: undefined as ((from: string) => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    renameSync(from: string, to: string): void {
      const neighbour = race.neighbour;
      // Захват текущего файла — то самое место, где сосед успевает вклиниться:
      // до него прокрутка ещё ничего не решила, после — файл уже наш.
      if (neighbour !== undefined && String(from).endsWith('/app.jsonl')) {
        race.neighbour = undefined;
        neighbour();
      }
      race.breakRename?.(String(from));
      real.renameSync(from, to);
    },
  };
});
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LOGS_DIR,
  LOG_EVENTS,
  LOG_FILE,
  LOG_KEEP_FILES,
  LOG_MAX_BYTES,
  LOG_FIELD_LIMIT,
  LOG_TAIL_BYTES,
  ROTATION_CLAIM_FILE,
  ROTATION_LOCK_FILE,
  ROTATION_LOCK_STALE_MS,
  logFailure,
  logFilePath,
  readFailureLog,
  rotatedLogPath,
  type LogEntry,
} from '../server/log.js';

const NOW = new Date('2026-08-21T09:30:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-log-'));
});

afterEach(() => {
  race.neighbour = undefined;
  race.breakRename = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Путь захвата прокрутки: имя одно на каталог. */
function claimPath(): string {
  return resolve(dir, LOGS_DIR, ROTATION_CLAIM_FILE);
}

/** Путь замка прокрутки. */
function lockPath(): string {
  return resolve(dir, LOGS_DIR, ROTATION_LOCK_FILE);
}

/** Разбирает текущий файл журнала построчно. */
function readEntries(): LogEntry[] {
  const text = readFileSync(logFilePath(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogEntry);
}

describe('журнал аварий', () => {
  it('пишет строку JSONL, которая разбирается обратно', () => {
    logFailure(
      {
        event: 'tenant-open-failed',
        message: 'база ребёнка не открылась',
        detail: 'SQLITE_CORRUPT',
        childId: 'abcdef01',
        route: '/api/run/plan?kind=normal',
        status: 503,
      },
      dir,
      NOW,
    );

    expect(readEntries()).toEqual([
      {
        at: '2026-08-21T09:30:00.000Z',
        event: 'tenant-open-failed',
        message: 'база ребёнка не открылась',
        detail: 'SQLITE_CORRUPT',
        childId: 'abcdef01',
        route: '/api/run/plan?kind=normal',
        status: 503,
      },
    ]);
  });

  it('заводит каталог журнала сам и дописывает строки в порядке записи', () => {
    expect(existsSync(resolve(dir, LOGS_DIR))).toBe(false);

    logFailure({ event: 'startup-failed', message: 'первая' }, dir, NOW);
    logFailure({ event: 'control-error', message: 'вторая' }, dir, NOW);

    const entries = readEntries();
    expect(entries.map((entry) => entry.message)).toEqual(['первая', 'вторая']);
    // Необязательные поля не превращаются в `null`: читателю журнала «поля нет»
    // и «поле пустое» иначе выглядели бы одинаково.
    expect(Object.keys(entries[0] ?? {})).toEqual(['at', 'event', 'message']);
  });

  it('прячет токен и в сообщении, и в подробностях, и в адресе', () => {
    const token = 'СЕКРЕТ-0123456789abcdef';
    logFailure(
      {
        event: 'server-error',
        message: `не удалось погасить /join/${token}: приглашение просрочено`,
        detail: `ссылка была /invite/${token}`,
        route: `/api/auth/parent/invite/${token}?retry=1`,
      },
      dir,
      NOW,
    );

    const text = readFileSync(logFilePath(dir), 'utf8');
    expect(text).not.toContain(token);
    const [entry] = readEntries();
    expect(entry?.message).toBe('не удалось погасить /join/<token>: приглашение просрочено');
    expect(entry?.detail).toBe('ссылка была /invite/<token>');
    // У адреса строка запроса сохраняется: токена в ней нет, а отличать по ней
    // один отказ от другого приходится.
    expect(entry?.route).toBe('/api/auth/parent/invite/<token>?retry=1');
  });

  it('крутит файл на границе размера, а не после неё', () => {
    // Файл добивается почти до предела одной большой строкой: гонять восемь
    // мегабайт настоящими записями значило бы тестировать скорость диска.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);

    logFailure({ event: 'sweep-failed', message: 'после границы' }, dir, NOW);

    expect(readEntries()).toHaveLength(1);
    expect(readEntries()[0]?.message).toBe('после границы');
    expect(readFileSync(rotatedLogPath(1, dir), 'utf8')).toBe(`${filler}\n`);
  });

  it('не теряет запись, когда журнал прокрутил сосед', () => {
    // `ENOENT` на прокрутке — не отказ, а «эту работу сделали за нас». Вылетев
    // наружу, он унёс бы с собой саму запись об аварии: она ушла бы в stderr,
    // то есть потерялась ровно там, ради чего журнал и заведён.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Сосед перешагнул предел первым и успел унести файл к себе.
    race.neighbour = () => {
      writeFileSync(`${logFilePath(dir)}.сосед`, readFileSync(logFilePath(dir)));
      rmSync(logFilePath(dir));
    };

    logFailure({ event: 'sweep-failed', message: 'после чужой прокрутки' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    expect(readEntries()).toHaveLength(1);
    expect(readEntries()[0]?.message).toBe('после чужой прокрутки');
  });

  it('не крутит журнал вторым заходом следом за соседом', () => {
    // Оба писателя перешагнули предел на одном и том же файле, но сосед успел
    // прокрутить журнал первым. Прокрученный вслед за ним, журнал сдвинул бы
    // архивы дважды — то есть выдавил бы из хранимых лишние восемь мегабайт
    // ровно потому, что аварии писали двое.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    const older = `${JSON.stringify({ at: '2026-08-21T09:00:00.000Z', event: 'sweep-failed', message: 'архив' })}\n`;
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    writeFileSync(rotatedLogPath(1, dir), older);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const neighbourLine = `${JSON.stringify({ at: '2026-08-21T09:29:00.000Z', event: 'sweep-failed', message: 'сосед' })}\n`;
    race.neighbour = () => {
      writeFileSync(rotatedLogPath(2, dir), readFileSync(rotatedLogPath(1, dir)));
      writeFileSync(rotatedLogPath(1, dir), readFileSync(logFilePath(dir)));
      writeFileSync(logFilePath(dir), neighbourLine);
    };

    logFailure({ event: 'sweep-failed', message: 'после чужой прокрутки' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    // Архивы сдвинуты ровно один раз: третьего файла не появилось, а самый
    // старый архив остался на своём месте.
    expect(existsSync(rotatedLogPath(3, dir))).toBe(false);
    expect(readFileSync(rotatedLogPath(1, dir), 'utf8')).toBe(`${filler}\n`);
    expect(readFileSync(rotatedLogPath(2, dir), 'utf8')).toBe(older);
    // Запись соседа, попавшая в захваченный файл, возвращается в ленту, а не
    // пропадает вместе с ним.
    expect(readEntries().map((entry) => entry.message)).toEqual(['сосед', 'после чужой прокрутки']);
    // Захват после себя ничего не оставляет.
    expect(readdirSync(resolve(dir, LOGS_DIR)).sort()).toEqual([
      'app.1.jsonl',
      'app.2.jsonl',
      LOG_FILE,
    ]);
  });

  it('возвращает захват в ленту, когда прокрутка сорвалась после него', () => {
    // Захваченный файл читателю ленты не виден: он смотрит только `app.jsonl` и
    // архивы. Оставленный после сорвавшейся прокрутки, он превращает восемь
    // мегабайт аварий в «аварий не было» — и это ещё до того, как следующая
    // прокрутка перепишет его тем же именем.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // На диске кончилось место ровно между захватом и сдвигом архивов.
    race.breakRename = (from) => {
      if (!from.includes('/app.rotating.')) return;
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };

    logFailure({ event: 'sweep-failed', message: 'после срыва' }, dir, NOW);

    // Причина уходит в stderr, но лента остаётся целой: захвата в каталоге нет,
    // а его содержимое вернулось в текущий файл.
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(readdirSync(resolve(dir, LOGS_DIR))).toEqual([LOG_FILE]);
    expect(readFileSync(logFilePath(dir), 'utf8')).toBe(`${filler}\n`);
  });

  it('подбирает захват, брошенный убитым процессом, и не переименовывает поверх него', () => {
    // Имя захвата одно на каталог, а не на процесс: заводит его только держатель
    // замка. Имя с PID отвечало бы иначе — процесс, убитый посреди прокрутки,
    // уносил бы восемь мегабайт аварий навсегда, потому что у следующего
    // запуска PID другой и своим этот захват он не считает никогда. Следующая
    // прокрутка вдобавок унесла бы текущий файл поверх брошенного.
    const stale = `${JSON.stringify({ at: '2026-08-21T09:00:00.000Z', event: 'sweep-failed', message: 'из брошенного захвата' })}\n`;
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(claimPath(), stale);
    writeFileSync(logFilePath(dir), `${filler}\n`);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logFailure({ event: 'sweep-failed', message: 'после подбора' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    expect(readdirSync(resolve(dir, LOGS_DIR)).sort()).toEqual(['app.1.jsonl', LOG_FILE]);
    // Брошенные записи вернулись в ленту и уехали в архив вместе с ней.
    expect(readFileSync(rotatedLogPath(1, dir), 'utf8')).toBe(`${filler}\n${stale}`);
    expect(readEntries().map((entry) => entry.message)).toEqual(['после подбора']);
  });

  it('показывает брошенный захват в ленте, не дожидаясь следующей прокрутки', () => {
    // Подбор захвата случается на прокрутке, то есть когда журнал снова дорос
    // до восьми мегабайт. Ждать её — значит прятать записи ровно после аварии,
    // которая прокрутку и оборвала: до неё захват не читает никто.
    const stale = `${JSON.stringify({ at: '2026-08-21T09:00:00.000Z', event: 'tenant-detached', message: 'из брошенного захвата' })}\n`;
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(claimPath(), stale);

    logFailure({ event: 'sweep-failed', message: 'свежая' }, dir, NOW);

    expect(readFailureLog(dir, {}).entries.map((entry) => entry.message)).toEqual([
      'свежая',
      'из брошенного захвата',
    ]);
  });

  it('не крутит журнал, пока замок держит живой сосед', () => {
    // Замок берётся на всю прокрутку, а не только на захват: сдвиг архивов —
    // отдельная череда `rename`, и две прокрутки соседних поколений,
    // наложившись, переставляли бы файлы вперемешку, выдавливая из хранимых
    // лишний архив. Пропущенная прокрутка дешевле: строка уходит в переросший
    // предел текущий файл, а следующая запись попробует снова.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    // Замок живого владельца: свой же PID и свежая отметка времени.
    writeFileSync(lockPath(), String(process.pid));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logFailure({ event: 'sweep-failed', message: 'мимо чужой прокрутки' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(rotatedLogPath(1, dir))).toBe(false);
    // Строка не потерялась: она дописана в текущий файл, временно переросший
    // предел.
    expect(readFailureLog(dir, {}).entries.map((entry) => entry.message)).toEqual([
      'мимо чужой прокрутки',
    ]);
  });

  it('подбирает замок умершего владельца', () => {
    // Замок, оставленный убитым процессом, иначе запирал бы прокрутку навсегда,
    // а весь ретеншен журнала на прокрутке и держится: не крутится — растёт без
    // предела.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    // PID уже завершившегося процесса: живым его не считает никто.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(lockPath(), String(dead));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logFailure({ event: 'sweep-failed', message: 'после подбора замка' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    expect(readFileSync(rotatedLogPath(1, dir), 'utf8')).toBe(`${filler}\n`);
    expect(readdirSync(resolve(dir, LOGS_DIR)).sort()).toEqual(['app.1.jsonl', LOG_FILE]);
  });

  it('не подбирает старый замок живого владельца', () => {
    // Возраст не доказывает смерть владельца: процесс мог быть остановлен
    // сборщиком мусора или ОС. Подобрав его замок, сосед заведёт новый, а
    // проснувшийся первый процесс удалит этот новый замок в своём `finally`.
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    writeFileSync(logFilePath(dir), `${filler}\n`);
    writeFileSync(lockPath(), String(process.pid));
    const aged = (Date.now() - ROTATION_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lockPath(), aged, aged);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logFailure({ event: 'sweep-failed', message: 'мимо старого живого замка' }, dir, NOW);

    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(rotatedLogPath(1, dir))).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
    expect(readFailureLog(dir, {}).entries.map((entry) => entry.message)).toEqual([
      'мимо старого живого замка',
    ]);
  });

  it('не крутит файл, которому строка ещё влезает', () => {
    logFailure({ event: 'sweep-failed', message: 'первая' }, dir, NOW);
    logFailure({ event: 'sweep-failed', message: 'вторая' }, dir, NOW);

    expect(readEntries()).toHaveLength(2);
    expect(existsSync(rotatedLogPath(1, dir))).toBe(false);
  });

  it('хранит не больше LOG_KEEP_FILES файлов', () => {
    const filler = 'x'.repeat(LOG_MAX_BYTES - 10);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    // Каждая запись переполняет текущий файл и сдвигает архивы на один номер.
    for (let round = 0; round < LOG_KEEP_FILES + 2; round += 1) {
      writeFileSync(logFilePath(dir), `${filler}#${round}\n`);
      logFailure({ event: 'backup-failed', message: `круг ${round}` }, dir, NOW);
    }

    const files = readdirSync(resolve(dir, LOGS_DIR)).sort();
    expect(files).toHaveLength(LOG_KEEP_FILES);
    expect(files).toEqual(['app.1.jsonl', 'app.2.jsonl', 'app.3.jsonl', LOG_FILE]);
  });

  it('пишет строку длиннее предела, а не выбрасывает её', () => {
    // Пустой файл не крутится: иначе строка, которая заведомо не влезает,
    // прокручивала бы журнал на каждой записи и стирала всё, что в нём было.
    logFailure({ event: 'control-error', message: 'x'.repeat(LOG_MAX_BYTES + 1) }, dir, NOW);

    expect(readEntries()).toHaveLength(1);
    expect(existsSync(rotatedLogPath(1, dir))).toBe(false);
  });

  it('отказ записи не бросает наружу, а уходит в stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Каталог данных занят файлом: завести под ним `logs/` невозможно.
    const busy = join(dir, 'занято');
    writeFileSync(busy, 'не каталог');

    expect(() => logFailure({ event: 'server-error', message: 'беда' }, busy, NOW)).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('server-error');
  });

  it('держит закрытый список событий', () => {
    // Свободная строка означала бы, что опечатка в новом месте вызова заводит
    // категорию, невидимую ни одному фильтру админки.
    expect([...LOG_EVENTS]).toEqual([
      'server-error',
      'tenant-open-failed',
      'tenant-detached',
      'control-error',
      'startup-failed',
      'codex-unavailable',
      'codex-run-failed',
      'sweep-failed',
      'prefetch-failed',
      'backup-failed',
      'login-lockout',
    ]);
  });

  it('держит список событий продублированным на клиенте', () => {
    // Импортировать `server/` клиенту нечем, а без списка на месте у фильтра
    // админки нет ни одного варианта на пустом журнале. Разъехавшаяся копия не
    // роняет ничего — она просто прячет от оператора целый род аварий, и
    // заметить это можно только в день, когда авария случилась. Поэтому копия
    // сверяется текстом файла: своего импорта у теста тоже нет.
    const client = readFileSync(resolve('web/src/admin-api.ts'), 'utf8');
    const start = client.indexOf('export const ADMIN_LOG_EVENTS = [');
    expect(start).toBeGreaterThan(-1);
    const listed = client.slice(start, client.indexOf('] as const;', start));
    const copy = [...listed.matchAll(/'([a-z-]+)'/gu)].map((found) => found[1]);
    expect(copy).toEqual([...LOG_EVENTS]);
  });

  it('у каждого события списка есть место вызова', () => {
    // Событие, которое никто не пишет, — это вариант фильтра, всегда дающий
    // пустую ленту, а пустая лента читается как «аварий такого рода не было».
    // Выбрав `backup-failed`, оператор получал бы утверждение, что с копиями всё
    // в порядке, вообще ни на чём не основанное.
    const sources: string[] = [];
    const walk = (from: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const full = join(from, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && full !== resolve('server/log.ts')) {
          sources.push(readFileSync(full, 'utf8'));
        }
      }
    };
    walk(resolve('server'));
    walk(resolve('scripts'));
    const text = sources.join('\n');

    const orphans = LOG_EVENTS.filter((event) => !text.includes(`event: '${event}'`));
    expect(orphans).toEqual([]);
  });

  it('обрезает длинные поля записи, а не кладёт в журнал строку длиннее хвоста', () => {
    // В `detail` уезжает вывод codex — до мегабайта (`MAX_CHILD_OUTPUT_BYTES`).
    // Одна запись длиннее видимого хвоста (`LOG_TAIL_BYTES`) не просто занимает
    // место: срез хвоста целиком попадает внутрь неё, оборванная первая строка
    // выбрасывается, бюджет на архивы уже потрачен — и лента оператора
    // оказывается пустой ровно после большой аварии.
    logFailure(
      { event: 'codex-run-failed', message: 'ц'.repeat(50000), detail: 'д'.repeat(600000) },
      dir,
      NOW,
    );
    logFailure({ event: 'server-error', message: 'после большой' }, dir, NOW);

    const written = readEntries();
    expect(written[0]?.message.endsWith('… (обрезано)')).toBe(true);
    expect(written[0]?.detail?.endsWith('… (обрезано)')).toBe(true);
    expect(Buffer.byteLength(written[0]?.detail ?? '')).toBeLessThan(LOG_TAIL_BYTES);

    // И главное: соседняя запись читается, а не пропадает вместе с хвостом.
    expect(readFailureLog(dir, {}).entries.map((entry) => entry.event)).toEqual([
      'server-error',
      'codex-run-failed',
    ]);
  });

  it('держит калибровочные константы спеки: предел файла и число файлов', () => {
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(LOG_KEEP_FILES).toBe(4);
    expect(LOG_FIELD_LIMIT).toBe(4096);
    expect(LOG_MAX_BYTES * LOG_KEEP_FILES).toBe(33554432);
    expect(LOGS_DIR).toBe('logs');
    expect(LOG_FILE).toBe('app.jsonl');
    expect(ROTATION_CLAIM_FILE).toBe('app.rotating.jsonl');
    expect(ROTATION_LOCK_FILE).toBe('app.rotating.lock');
    expect(ROTATION_LOCK_STALE_MS).toBe(60000);
  });
});
