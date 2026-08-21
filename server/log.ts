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
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
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

/**
 * Предел длины текстовых полей записи.
 *
 * Ни `message`, ни `detail` не приходят из кода целиком: в `detail` уезжает
 * вывод codex (`MAX_CHILD_OUTPUT_BYTES` — мегабайт) и сообщения драйвера. Одна
 * такая строка длиннее видимого хвоста (`LOG_TAIL_BYTES`) не просто занимает
 * место — она **стирает ленту**: срез хвоста целиком попадает внутрь неё,
 * оборванная первая строка выбрасывается, бюджет на архивы уже потрачен, и
 * оператор читает «аварий не было» ровно в тот момент, когда случилась
 * большая. Обрезка помечается явно: молча укороченный вывод модели читался бы
 * как её настоящий ответ.
 */
export const LOG_FIELD_LIMIT = 4 * 1024;

/** Обрезает текст записи до предела, называя обрезку. */
function clampField(value: string): string {
  if (Buffer.byteLength(value) <= LOG_FIELD_LIMIT) return value;
  // Режется по знакам, а не по байтам: срез посреди многобайтного знака дал бы
  // в файле битый UTF-8, который потом не разберёт `parseEntry`.
  let kept = '';
  let bytes = 0;
  for (const symbol of value) {
    const size = Buffer.byteLength(symbol);
    if (bytes + size > LOG_FIELD_LIMIT) break;
    kept += symbol;
    bytes += size;
  }
  return `${kept}… (обрезано)`;
}

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
 * Пора ли крутить журнал: строка не влезает в остаток предела.
 *
 * Пустой файл не крутится — строка длиннее предела иначе прокручивала бы
 * журнал на каждой записи, стирая всё, что в нём было.
 *
 * Ответ здесь предварительный: писать в журнал могут два процесса сразу
 * (сервер и `scripts/backup.ts`, который замка каталога намеренно не берёт), и
 * между этим замером и самой прокруткой сосед успевает прокрутить журнал сам.
 * Окончательное решение принимает `rotate` — уже на захваченном файле.
 */
function overflows(path: string, line: string): boolean {
  const size = sizeOf(path);
  return size > 0 && size + Buffer.byteLength(line) > LOG_MAX_BYTES;
}

/**
 * Имя, которым процесс забирает текущий файл себе на время прокрутки, и имя
 * замка самой прокрутки.
 *
 * Захват один на каталог, а не на процесс: заводит его только держатель замка,
 * поэтому найденный под замком захват брошен **всегда** — чей бы процесс его ни
 * оставил. Имя с PID отвечало бы на этот вопрос иначе: захват, брошенный
 * убитым процессом, следующий запуск не узнавал бы вовсе (PID другой), и восемь
 * мегабайт аварий оставались бы невидимыми навсегда.
 */
export const ROTATION_CLAIM_FILE = 'app.rotating.jsonl';
export const ROTATION_LOCK_FILE = 'app.rotating.lock';

/**
 * Сколько замок прокрутки считается живым по одному своему возрасту.
 *
 * Прокрутка — это несколько `rename`, то есть миллисекунды; минута отличает
 * брошенный пустой или повреждённый замок от файла, который настоящий владелец
 * ещё не успел заполнить. Разборчивый живой PID возрастом не перебивается:
 * безопасно отличить переиспользованный PID от долгой паузы владельца нельзя.
 */
export const ROTATION_LOCK_STALE_MS = 60_000;

function rotationClaimPath(dir: string): string {
  return resolve(dir, LOGS_DIR, ROTATION_CLAIM_FILE);
}

function rotationLockPath(dir: string): string {
  return resolve(dir, LOGS_DIR, ROTATION_LOCK_FILE);
}

/** Имя, которым процесс уносит брошенный замок: убрать его должен ровно один. */
function lockTakeoverPath(dir: string): string {
  return resolve(dir, LOGS_DIR, `app.rotating.${process.pid}.lock`);
}

/**
 * Заводит замок исключительным созданием файла.
 *
 * `wx` атомарен, поэтому из писателей, перешагнувших предел одновременно,
 * крутит журнал ровно один, а остальные получают `EEXIST` и уходят писать в
 * текущий файл. Замка мало для захвата, но именно он держит **всю** прокрутку
 * целиком: сдвиг архивов состоит из отдельных `rename`, и наложение двух
 * прокруток разных поколений переставляло бы их вперемешку, выдавливая из
 * хранимых лишний архив.
 *
 * Любой другой отказ создания — тоже «не наш ход», а не авария: прокрутка
 * вспомогательна, строка уйдёт в переросший предел текущий файл, и настоящую
 * причину назовёт уже дозапись, упав на том же каталоге.
 */
function createRotationLock(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    return false;
  }
  try {
    // В замке лежит PID владельца: по нему брошенный замок узнаётся сразу, а не
    // через минуту его срока.
    writeSync(fd, String(process.pid));
  } catch {
    /* пустой замок не хуже: возраст у него всё равно есть */
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Жив ли владелец замка. `EPERM` — процесс есть, просто чужой. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Брошен ли замок. Живой владелец всегда сильнее возраста: иначе процесс A,
 * остановленный дольше минуты, мог проснуться после подбора его замка процессом
 * B и удалить уже новый замок B в своём `finally`. Возраст применяется только
 * к замку без разборчивого живого PID. Ошибиться в сторону «занят» безопасно —
 * прокрутка просто откладывается до следующей записи.
 */
function lockAbandoned(lock: string, now: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    // Замок исчез сам: подбирать нечего, хватит обычной попытки его завести.
    return false;
  }
  let owner: number;
  try {
    owner = Number(readFileSync(lock, 'utf8').trim());
  } catch {
    return false;
  }
  // Замок без разборчивого PID нельзя ни подтвердить, ни опровергнуть, и до
  // истечения срока он считается живым: пустым его оставляет отказ записи сразу
  // после создания, то есть у настоящего владельца.
  if (!Number.isInteger(owner) || owner <= 0) {
    return now - mtimeMs > ROTATION_LOCK_STALE_MS;
  }
  return !processAlive(owner);
}

/** Берёт замок прокрутки, подбирая брошенный. Не взяли — крутит сосед. */
function acquireRotationLock(dir: string): boolean {
  const lock = rotationLockPath(dir);
  if (createRotationLock(lock)) return true;
  if (!lockAbandoned(lock, Date.now())) return false;
  // Брошенный замок уносится **переименованием** в своё имя, а не удаляется:
  // `rename` атомарен, так что из двоих подобравших его получает ровно один, а
  // второй, дошедший до `unlink` позже, снял бы с прокрутки уже новый, живой
  // замок первого.
  const takeover = lockTakeoverPath(dir);
  try {
    renameSync(lock, takeover);
  } catch {
    return false;
  }
  try {
    unlinkSync(takeover);
  } catch {
    /* уносили не мы */
  }
  return createRotationLock(lock);
}

/** Отпускает замок. Его отсутствие — не беда: значит, его подобрали как брошенный. */
function releaseRotationLock(dir: string): void {
  try {
    unlinkSync(rotationLockPath(dir));
  } catch {
    /* замка уже нет */
  }
}

/**
 * Возвращает захваченный файл в общую ленту.
 *
 * Переименовать его назад нельзя: сосед, прокрутивший журнал первым, уже пишет
 * в новый текущий файл, и `rename` поверх стёр бы его записи. Порядок строк от
 * дозаписи не страдает — страница читается устойчивой сортировкой по `at`, а не
 * порядком в файле.
 */
function restoreClaim(claim: string, current: string): void {
  const kept = readFileSync(claim);
  if (kept.length > 0) appendFileSync(current, kept);
  unlinkSync(claim);
}

/**
 * Переименовывает, прощая исчезнувший источник.
 *
 * Архивы сдвигает только тот, кто захватил текущий файл, но захваты соседних
 * поколений теоретически накладываются, и тогда второму файл под руками
 * переименовывает первый. `ENOENT` здесь — не отказ, а «эту работу сделали за
 * нас»: вылетев наружу, он уносил бы с собой и саму запись об аварии — она
 * уходила бы в stderr, то есть терялась ровно там, ради чего журнал и заведён.
 */
function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Крутит журнал под замком.
 *
 * Замок берётся на **всю** прокрутку, а не только на захват текущего файла:
 * захват отвечает лишь за то, чей это файл, а сдвиг архивов — отдельная череда
 * `rename`, и две прокрутки соседних поколений, наложившись, переставляли бы их
 * вперемешку. Один архив при этом уезжает поверх другого, то есть из хранимых
 * пропадают восемь мегабайт аварий ровно потому, что их писали двое.
 *
 * Не взяли замок — прокрутки не будет: строка уйдёт в текущий файл, временно
 * переросший предел, а следующая запись попробует снова. Пропущенная прокрутка
 * дешевле наложившейся.
 */
function rotate(dir: string, line: string): void {
  if (!acquireRotationLock(dir)) return;
  try {
    rotateLocked(dir, line);
  } finally {
    releaseRotationLock(dir);
  }
}

/**
 * Сдвигает файлы на один номер вперёд. Самый старый не убирается отдельно:
 * `rename` поверх него и есть его удаление, а отдельный `rm` оставил бы окно, в
 * котором хранимых файлов на один меньше обещанного.
 *
 * Начинается прокрутка с **захвата** текущего файла отдельным именем, и это не
 * лишний шаг: `rename` атомарен, так что текущий файл уходит из ленты целиком и
 * сразу, а писатель, дозаписывающий в этот момент строку, заводит новый файл, а
 * не пишет в уезжающий архив. Проверки размера перед прокруткой для этого мало:
 * она отвечает на вопрос о файле, который к моменту сдвига может быть уже чужим
 * архивом.
 */
function rotateLocked(dir: string, line: string): void {
  const current = logFilePath(dir);
  const claim = rotationClaimPath(dir);
  // Под замком чужой прокрутки не идёт, поэтому найденный здесь захват брошен
  // всегда — своей прерванной прокруткой или убитым процессом, безразлично.
  if (!recoverStaleClaim(claim, current)) return;
  try {
    renameSync(current, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Файл под руками уже переименовал сосед: крутить нечего, строка уйдёт в
    // заведённый им новый.
    return;
  }

  try {
    // Размер меряется заново и уже на своём файле: сосед мог прокрутить журнал
    // между проверкой и захватом, и тогда в руках оказался бы новый, почти
    // пустой текущий файл. Прокрученный, он выдавил бы из хранимых лишний архив.
    if (sizeOf(claim) + Buffer.byteLength(line) <= LOG_MAX_BYTES) {
      restoreClaim(claim, current);
      return;
    }

    for (let index = LOG_KEEP_FILES - 2; index >= 1; index -= 1) {
      const from = rotatedLogPath(index, dir);
      if (sizeOf(from) === 0) continue;
      renameIfPresent(from, rotatedLogPath(index + 1, dir));
    }
    renameSync(claim, rotatedLogPath(1, dir));
  } catch (error) {
    // Всё, что после захвата, обязано либо доехать, либо вернуть файл в ленту:
    // брошенный захват читателю не виден вовсе, и до следующей прокрутки
    // восемь мегабайт аварий читаются как «аварий не было». Возврат идёт своим
    // `try` — его отказ не имеет права заслонить причину, ради которой сюда и
    // попали, а не вернувшийся захват подберёт `recoverStaleClaim`.
    try {
      restoreClaim(claim, current);
    } catch {
      /* захват остаётся до следующей прокрутки */
    }
    throw error;
  }
}

/**
 * Возвращает в ленту захват, брошенный прерванной прокруткой — своей или
 * умершего вместе с ней процесса.
 *
 * Имя захвата одно на каталог, поэтому следующая прокрутка переименовала бы
 * текущий файл **поверх** него, и брошенные восемь мегабайт исчезли бы
 * навсегда. Отказ самого возврата отменяет прокрутку, а не летит наружу: захват
 * пережил уже одну аварию и обязан пережить эту, а строка уйдёт в переросший
 * предел текущий файл (перерастание временное — следующая прокрутка попробует
 * снова). Настоящую причину назовёт та же запись, упав уже на дозаписи.
 */
function recoverStaleClaim(claim: string, current: string): boolean {
  if (!existsSync(claim)) return true;
  try {
    restoreClaim(claim, current);
    return true;
  } catch {
    return false;
  }
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
    message: clampField(redactTokenText(record.message)),
    ...(record.detail === undefined ? {} : { detail: clampField(redactTokenText(record.detail)) }),
    ...(record.childId === undefined ? {} : { childId: record.childId }),
    // Адрес приходит целиком, поэтому у него строка запроса сохраняется.
    ...(record.route === undefined ? {} : { route: redactTokenUrl(record.route) }),
    ...(record.status === undefined ? {} : { status: record.status }),
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    const path = logFilePath(dir);
    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    if (overflows(path, line)) rotate(dir, line);
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
    // Признак среза считается по `from`, а не по `start`: при `start === 1`
    // байт «сверх бюджета» оказывается самым первым байтом файла, то есть
    // прочитано всё и резать нечего, — а `start > 0` заставлял бы выбросить
    // целую первую запись.
    return { text: buffer.toString('utf8'), bytes: size - start, cut: from > 0 };
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
  // Брошенный захват читается наравне с лентой, хотя подберёт его и следующая
  // прокрутка: ждать её — значит держать записи невидимыми до тех пор, пока
  // журнал снова не дорастёт до восьми мегабайт, то есть прятать аварию ровно
  // после аварии, которая прокрутку и оборвала. Лежит он между архивом и
  // текущим файлом: захватывается именно текущий, а архивы к этому моменту
  // уже сдвинуты. Живая прокрутка на миллисекунды показывает его записи дважды
  // — возврат в ленту дозаписью успевает опередить `unlink`; повтор пары строк
  // в ленте несравним с восемью мегабайтами, которых в ней нет.
  if (rest > 0) {
    const claimed = readTail(rotationClaimPath(dir), rest);
    if (claimed.bytes > 0) {
      entries.unshift(...entriesOf(claimed));
      rest -= claimed.bytes;
    }
  }
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
  // Файл лежит в порядке дозаписи, а не отметок: писать в него могут два
  // процесса сразу (сервер и `scripts/backup.ts`, который замка каталога
  // намеренно не берёт), и запись с более поздней отметкой попадает в файл
  // раньше соседней. Курсор же ищет границу страницы одним проходом «пока
  // `at` больше курсора» — на переставленной паре он останавливается раньше
  // времени и отдаёт ту же запись страницу за страницей. Сортировка
  // устойчивая: у записей одной отметки порядок дозаписи остаётся, и счётчик
  // `#<сколько отдано>` в курсоре считает те же самые строки.
  all.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
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
