/**
 * Журнал аварий: одна строка JSONL на происшествие.
 *
 * Файл, а не таблица в `control.db`, — потому что записывать надо ровно те
 * случаи, когда с базой что-то не так: отказ открытия аренды, подмена файла,
 * недоступная управляющая база. Хранилище, отказывающее вместе с предметом
 * записи, бесполезно именно в тот момент, ради которого заведено. Плюс запись
 * под WAL конкурировала бы со входами, а ротацию по объёму на SQLite пришлось
 * бы писать руками.
 *
 * `stderr` при этом остаётся: процесс, упавший до того, как каталог данных
 * известен, виден только там.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './data-dir.js';
import { redactTokenText, redactTokenUrl } from './routes/token-privacy.js';

/**
 * Что вообще может случиться. Список закрыт намеренно: фильтр в админке имеет
 * смысл, только если множество значений конечно, а свободная строка означала бы,
 * что опечатка в новом месте вызова заводит собственную категорию, невидимую ни
 * одному фильтру.
 */
export const LOG_EVENTS = [
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
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

/** Что просят записать. Тел запросов и содержимого ответов ребёнка здесь нет. */
export interface FailureRecord {
  event: LogEvent;
  message: string;
  detail?: string;
  childId?: string;
  route?: string;
  status?: number;
}

/** Запись журнала: то же самое плюс отметка времени в ISO. */
export interface LogEntry extends FailureRecord {
  at: string;
}

/** Каталог журнала внутри каталога данных. */
export const LOGS_DIR = 'logs';

/** Имя текущего файла журнала. */
export const LOG_FILE = 'app.jsonl';

/**
 * Предел одного файла и число хранимых файлов. Произведение — 32 МБ — и есть
 * весь ретеншен: удаления по времени нет, а расти журналу некуда, потому что он
 * лежит на одном диске с детскими базами, и «логи съели место под прогресс»
 * закрывается арифметикой, а не надеждой.
 */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_KEEP_FILES = 4;

/** Путь текущего файла журнала. */
export function logFilePath(dir: string = dataDir()): string {
  return resolve(dir, LOGS_DIR, LOG_FILE);
}

/**
 * Путь архива по номеру: `1` — предыдущий файл, `LOG_KEEP_FILES - 1` — самый
 * старый из хранимых.
 */
export function rotatedLogPath(index: number, dir: string = dataDir()): string {
  return resolve(dir, LOGS_DIR, `app.${index}.jsonl`);
}

/** Размер файла, либо `0`, если его ещё нет. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Сдвигает файлы на один номер вперёд. Самый старый не убирается отдельно:
 * `rename` поверх него и есть его удаление, а отдельный `rm` оставил бы окно, в
 * котором хранимых файлов на один меньше обещанного.
 */
function rotate(dir: string): void {
  for (let index = LOG_KEEP_FILES - 2; index >= 1; index -= 1) {
    const from = rotatedLogPath(index, dir);
    if (sizeOf(from) === 0) continue;
    renameSync(from, rotatedLogPath(index + 1, dir));
  }
  renameSync(logFilePath(dir), rotatedLogPath(1, dir));
}

/**
 * Записывает происшествие.
 *
 * Синхронно и с дозаписью: авария часто идёт последним, что процесс успевает
 * сделать, и отложенная запись не доехала бы. Отказ самой записи ничего не
 * роняет — журнал вспомогательный, и запрос, упавший из-за того, что не удалось
 * записать причину его падения, поменял бы одну беду на две.
 */
export function logFailure(
  record: FailureRecord,
  dir: string = dataDir(),
  now: Date = new Date(),
): void {
  const entry: LogEntry = {
    at: now.toISOString(),
    event: record.event,
    message: redactTokenText(record.message),
    ...(record.detail === undefined ? {} : { detail: redactTokenText(record.detail) }),
    ...(record.childId === undefined ? {} : { childId: record.childId }),
    // Адрес приходит целиком, поэтому у него строка запроса сохраняется.
    ...(record.route === undefined ? {} : { route: redactTokenUrl(record.route) }),
    ...(record.status === undefined ? {} : { status: record.status }),
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    const path = logFilePath(dir);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    const size = sizeOf(path);
    // Пустой файл не крутится: строка длиннее предела иначе прокручивала бы
    // журнал на каждой записи, стирая всё, что в нём было.
    if (size > 0 && size + Buffer.byteLength(line) > LOG_MAX_BYTES) rotate(dir);
    appendFileSync(path, line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`не удалось записать журнал (${record.event}): ${reason}\n`);
  }
}

/**
 * Куда модуль сообщает об аварии. Отдельный тип, а не прямой вызов
 * `logFailure`, потому что каталог данных знает не всякий модуль: диспетчер
 * прогрева процессный и о путях не знает вовсе, а тест обязан получать записи
 * во временный каталог, а не в `data/` рядом с кодом.
 */
export type FailureLog = (record: FailureRecord) => void;

/** Журнал, привязанный к каталогу данных. */
export function failureLogFor(dir: string): FailureLog {
  return (record) => {
    logFailure(record, dir);
  };
}
