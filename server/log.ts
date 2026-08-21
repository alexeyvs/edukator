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
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
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

/**
 * Сколько хвоста журнала читается на запрос. Экран аварий смотрит на последнее
 * случившееся, а файл может быть и восьмимегабайтным: читать его целиком —
 * значит держать в памяти восемь мегабайт ради двух сотен строк.
 */
export const LOG_TAIL_BYTES = 512 * 1024;

/** Сколько записей отдаёт одна страница админского журнала. */
export const ADMIN_LOG_PAGE = 200;

/** Что спрашивают у журнала. */
export interface LogQuery {
  event?: LogEvent;
  childId?: string;
  /** Курсор: `<отметка>#<сколько записей с этой отметкой уже отдано>`. */
  before?: string;
  limit?: number;
}

/** Страница журнала, новые сверху. */
export interface LogPage {
  entries: LogEntry[];
  /** Курсор следующей страницы; его нет, когда отдано всё. */
  nextBefore?: string;
}

/** Известное ли это событие. Пришедшее из запроса значение — недоверенное. */
export function isLogEvent(value: string): value is LogEvent {
  return (LOG_EVENTS as readonly string[]).includes(value);
}

/** Хвост файла: последние `budget` байт и признак того, что срез был. */
function readTail(path: string, budget: number): { text: string; bytes: number; cut: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', bytes: 0, cut: false };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - budget);
    if (size - start === 0) return { text: '', bytes: 0, cut: false };
    // Байт перед срезом читается сверх бюджета: только по нему видно, разрубил
    // срез строку или лёг ровно на её начало. Без него целая первая запись
    // выбрасывалась бы всякий раз, когда граница совпала с переводом строки.
    const from = start > 0 ? start - 1 : 0;
    const length = size - from;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, from);
    // Срез мог разрубить и многобайтный знак, но он попал в первую строку, а её
    // всё равно выбрасывают: она оборвана самим срезом.
    return { text: buffer.toString('utf8'), bytes: size - start, cut: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Разбирает строку журнала. Возвращает `undefined` на всём, что не похоже на
 * запись: битая строка не имеет права закрыть весь экран, поэтому проверка
 * идёт поштучно, а не одним разбором всего файла.
 */
function parseEntry(line: string): LogEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const at = record['at'];
  const event = record['event'];
  const message = record['message'];
  if (typeof at !== 'string' || typeof event !== 'string' || !isLogEvent(event)) return undefined;
  if (typeof message !== 'string') return undefined;
  const detail = record['detail'];
  const childId = record['childId'];
  const route = record['route'];
  const status = record['status'];
  return {
    at,
    event,
    message,
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(typeof childId === 'string' ? { childId } : {}),
    ...(typeof route === 'string' ? { route } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  };
}

/** Записи одного файла, от старых к новым. */
function entriesOf(tail: { text: string; cut: boolean }): LogEntry[] {
  const lines = tail.text.split('\n');
  // Первая строка среза оборвана слева, и разбор дал бы либо мусор, либо —
  // хуже — правдоподобную запись с потерянным началом. Когда срез лёг ровно на
  // границу строк, первым элементом оказывается пустая строка от прочитанного
  // сверх бюджета перевода строки, и та же строчка убирает её.
  if (tail.cut) lines.shift();
  const entries: LogEntry[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const entry = parseEntry(line);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * Хвост журнала целиком: текущий файл, а если его не хватило до бюджета —
 * предыдущие по ротации. Возвращает записи от старых к новым.
 */
export function readFailureTail(dir: string = dataDir(), budget: number = LOG_TAIL_BYTES): LogEntry[] {
  const current = readTail(logFilePath(dir), budget);
  const entries = entriesOf(current);
  let rest = budget - current.bytes;
  for (let index = 1; index < LOG_KEEP_FILES && rest > 0; index += 1) {
    const older = readTail(rotatedLogPath(index, dir), rest);
    if (older.bytes === 0) break;
    entries.unshift(...entriesOf(older));
    rest -= older.bytes;
  }
  return entries;
}

/** Разбирает курсор в отметку и число уже отданных записей с этой отметкой. */
function parseCursor(before: string): { at: string; skip: number } {
  const marker = before.lastIndexOf('#');
  if (marker < 0) return { at: before, skip: 0 };
  const skip = Number(before.slice(marker + 1));
  if (!Number.isInteger(skip) || skip < 0) return { at: before.slice(0, marker), skip: 0 };
  return { at: before.slice(0, marker), skip };
}

/**
 * Страница журнала по запросу.
 *
 * Курсор не сводится к одной отметке времени: авария редко приходит одна, и
 * несколько записей одной миллисекунды — обычное дело. Строгое «раньше чем»
 * теряло бы соседей по границе страницы, нестрогое — повторяло бы их вечно,
 * поэтому в курсоре едет ещё и число уже отданных записей с этой отметкой.
 */
export function readFailureLog(dir: string = dataDir(), query: LogQuery = {}): LogPage {
  const limit = query.limit ?? ADMIN_LOG_PAGE;
  const all = readFailureTail(dir);
  all.reverse();
  const list = all.filter((entry) => {
    if (query.event !== undefined && entry.event !== query.event) return false;
    if (query.childId !== undefined && entry.childId !== query.childId) return false;
    return true;
  });

  let start = 0;
  if (query.before !== undefined) {
    const cursor = parseCursor(query.before);
    while (start < list.length && (list[start]?.at ?? '') > cursor.at) start += 1;
    start += cursor.skip;
  }
  const end = Math.min(start + limit, list.length);
  const entries = list.slice(start, end);
  if (end >= list.length || entries.length === 0) return { entries };

  const lastAt = entries[entries.length - 1]?.at ?? '';
  const sameAt = list.slice(0, end).filter((entry) => entry.at === lastAt).length;
  return { entries, nextBefore: `${lastAt}#${sameAt}` };
}
