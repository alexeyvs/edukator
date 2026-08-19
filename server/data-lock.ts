/**
 * Замок каталога данных: одно живое приложение на каталог.
 *
 * Нужен он не ради самих файлов — SQLite и под WAL переживает нескольких
 * писателей, — а ради бюджета codex. Предел одновременных вызовов процессный
 * (`server/codex/concurrency.ts`), так что второй процесс на том же каталоге
 * заводит вторую пару слотов: ровно тот сценарий, из-за которого отвергнут
 * вариант «процесс на ребёнка». Живой сервер плюс запущенный руками
 * `npm run prefetch` — четыре вызова модели вместо двух, и занятие ученика
 * встаёт в очередь за прогревом.
 *
 * Замок файловый и берётся `link` уже дописанной времянки: это единственная
 * атомарная операция, доступная и на локальном диске, и без демона, а в отличие
 * от `open(..., 'wx')` она не оставляет на месте замка пустого файла. В файле
 * лежит владелец — по нему замок переживший своего процесса отличается от
 * настоящего.
 *
 * Внутри одного процесса замок берётся сколько угодно раз и считается ссылками.
 * Защищаться там не от кого: бюджет вызовов — модульная переменная, и второй
 * сервер в том же процессе делит те же два слота, а не заводит свои. Тесты
 * маршрутов ровно этим и пользуются, поднимая рядом сервер с другим
 * проверяющим.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

/** Имя файла замка внутри каталога данных. */
export const DATA_LOCK_FILE = 'edukator.lock';

/** Путь замка внутри каталога данных. */
export function dataLockPath(dir: string): string {
  return resolve(dir, DATA_LOCK_FILE);
}

/**
 * Имена владельцев. Объявлены здесь, а не по месту: они попадают в текст
 * отказа, который читает человек, а второй стороной отказа всегда оказывается
 * не тот, кто его написал.
 */
export const SERVER_LOCK_OWNER = 'сервер';
export const PREFETCH_LOCK_OWNER = 'ручной прогрев';
/**
 * Перенос однопользовательской базы. Замок ему нужен не ради codex, а ради
 * самого каталога: пока ребёнок заводится, его база перебирается из времянки в
 * рабочее место, и живой сервер рядом обслуживал бы то, чего ещё нет.
 */
export const ADOPT_LOCK_OWNER = 'перенос однопользовательской базы';

/** Запись в файле замка: кто, когда и с каким разовым знаком его взял. */
export interface DataLockRecord {
  pid: number;
  /** Человекочитаемое имя владельца: попадает прямо в текст отказа. */
  owner: string;
  since: string;
  /**
   * Разовый знак взятия. Нужен на снятии: наш замок могли убрать руками, а на
   * его месте уже стоит чужой — и снять его значило бы пустить третий процесс.
   */
  nonce: string;
}

/** Взятый замок. Снимается один раз, повторное снятие ничего не делает. */
export interface DataLock {
  readonly path: string;
  release(): void;
}

/**
 * Замки, взятые этим процессом. Счётчик ссылок, а не флаг: файл снимается
 * последним из своих, иначе закрытие первого сервера открывало бы каталог
 * чужому процессу под живым вторым.
 */
const heldLocks = new Map<string, { count: number; nonce: string }>();

/** Каталог занят живым процессом. Отдельный класс — чтобы назвать владельца. */
export class DataLockBusyError extends Error {
  readonly path: string;
  readonly holder: DataLockRecord | undefined;

  constructor(dir: string, path: string, holder: DataLockRecord | undefined, detail?: string) {
    super(
      (holder === undefined
        ? `Каталог данных ${dir} занят: замок ${path} держит другой процесс`
        : `Каталог данных ${dir} занят: ${holder.owner} (pid ${holder.pid}) с ${holder.since}`) +
        (detail === undefined ? '' : `; ${detail}`),
    );
    this.name = 'DataLockBusyError';
    this.path = path;
    this.holder = holder;
  }
}

export interface AcquireDataLockOptions {
  /** Подменяемая проверка живости владельца: тесты не заводят процессов. */
  alive?: (pid: number) => boolean;
  now?: () => Date;
}

/**
 * Жив ли процесс с таким номером. `EPERM` — тоже «жив»: процесс есть, просто
 * чужой, и снимать его замок нельзя тем более.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRecord(path: string): DataLockRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // `undefined` здесь значит «замка нет», а из него следует «снять и взять».
    // Поэтому нечитаемый файл обязан отличаться от отсутствующего: `EACCES` или
    // `EMFILE` на чужом живом замке иначе давали бы разрешение его удалить —
    // ровно тот второй процесс со своей парой слотов codex, ради которого замок
    // и заведён.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string') return undefined;
    return {
      pid: parsed.pid,
      owner: typeof parsed.owner === 'string' ? parsed.owner : 'неизвестный процесс',
      since: typeof parsed.since === 'string' ? parsed.since : 'неизвестно когда',
      nonce: parsed.nonce,
    };
  } catch {
    return undefined;
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Исходная причина важнее неудачной уборки: занятость каталога всё равно
    // будет названа следующей попыткой создания.
  }
}

/**
 * Создаёт файл замка эксклюзивно; `EEXIST` означает чужой замок на месте.
 *
 * Запись собирается во времянке и въезжает на место одним `link`. Прямое
 * `openSync(path, 'wx')` тоже атомарно, но оставляет файл пустым на всё время
 * между созданием и `write` + `fsync`: соседний процесс, заглянувший в это
 * окно, прочёл бы замок без владельца, счёл бы его нечитаемым — то есть
 * брошенным, — снял бы и взял свой поверх живого.
 */
function writeExclusive(path: string, record: DataLockRecord): void {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = openSync(temp, 'wx');
  // Уборка накрывает и запись, и `link`: отказ `write`/`fsync` (кончилось место,
  // отвалился диск) иначе оставлял бы времянку навсегда — подметать её в корне
  // каталога данных некому, `dropStaleTemporaries` ходит только по `children/`.
  try {
    try {
      writeSync(handle, `${JSON.stringify(record)}\n`);
      // Замок читают из другого процесса, а его владелец может умереть в любой
      // момент: без сброса на диск после обрыва питания остался бы файл без
      // содержимого, то есть замок без владельца.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    linkSync(temp, path);
  } finally {
    removeQuietly(temp);
  }
}

/**
 * Берёт замок каталога данных.
 *
 * Замок после аварии не снимается автоматически. Проверка PID даёт полезную
 * диагностику, но не атомарное право удалить файл: два процесса могли увидеть
 * одну мёртвую запись, а затем один удалить уже новый живой замок другого.
 * Поэтому любой существующий файл означает fail-closed; оператор сначала
 * убеждается, что названного процесса нет, и удаляет `edukator.lock` вручную.
 */
export function acquireDataLock(
  dir: string,
  owner: string,
  options: AcquireDataLockOptions = {},
): DataLock {
  const path = dataLockPath(dir);
  mkdirSync(dir, { recursive: true });

  const mine = heldLocks.get(path);
  if (mine !== undefined) {
    mine.count += 1;
    return makeLock(path, mine.nonce);
  }

  const alive = options.alive ?? processAlive;
  const now = options.now ?? ((): Date => new Date());
  const nonce = randomBytes(8).toString('hex');
  const record: DataLockRecord = {
    pid: process.pid,
    owner,
    since: now().toISOString(),
    nonce,
  };

  try {
    writeExclusive(path, record);
    heldLocks.set(path, { count: 1, nonce });
    return makeLock(path, nonce);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const holder = readRecordOrBusy(dir, path);
  const dead = holder === undefined || holder.pid === process.pid || !alive(holder.pid);
  throw new DataLockBusyError(
    dir,
    path,
    holder,
    dead
      ? `замок выглядит брошенным; убедитесь, что владельца нет, и удалите ${path} вручную`
      : undefined,
  );
}

/**
 * Чтение замка там, где по нему принимают решение «снять чужой».
 *
 * Замок на месте, но прочитать его нечем (`EACCES` от чужого владельца,
 * `EMFILE` на исчерпанных дескрипторах): назвать владельца невозможно, а значит
 * невозможно и убедиться, что он мёртв. Ответ на это — занятость, а не поломка
 * запуска: `buildServer` гасит старт только на `DataLockBusyError`, а всякий
 * другой отказ считает незаписываемым каталогом и поднимается **без** замка —
 * то есть рядом с живым владельцем, со второй парой слотов codex, ради которой
 * замок и заведён.
 */
function readRecordOrBusy(dir: string, path: string): DataLockRecord | undefined {
  try {
    return readRecord(path);
  } catch (error) {
    throw new DataLockBusyError(dir, path, undefined, `замок не прочитан: ${(error as Error).message}`);
  }
}

/**
 * То же чтение там, где отказ не должен подменять собой причину: описание
 * занятого замка и снятие своего. Решения «снять чужой» на нём не принимают.
 */
function readRecordQuietly(path: string): DataLockRecord | undefined {
  try {
    return readRecord(path);
  } catch {
    return undefined;
  }
}

function makeLock(path: string, nonce: string): DataLock {
  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      const held = heldLocks.get(path);
      if (held === undefined || held.nonce !== nonce) return;
      held.count -= 1;
      if (held.count > 0) return;
      heldLocks.delete(path);
      const holder = readRecordQuietly(path);
      // Чужой замок не снимаем: наш могли убрать руками, а на его месте уже
      // стоит другой процесс.
      if (holder?.nonce !== nonce) return;
      removeQuietly(path);
    },
  };
}
