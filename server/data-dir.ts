/**
 * Каталог данных многоарендного сервера: `control.db` рядом с `children/<id>.db`.
 * Единой переменной с путём одной базы (прежний `EDUKATOR_DB`) здесь больше нет
 * намеренно: у сервера столько баз, сколько детей, и глобальная точка выбирала
 * бы за всех одну.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { syncDirectory } from './atomic-write.js';
import { openDatabase } from './db.js';
import {
  CHILDREN_DIR,
  childDatabasePath,
  markChildFailed,
  markChildReady,
  readChild,
} from './control-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Каталог данных по умолчанию. Лежит рядом с кодом, но в репозиторий не входит. */
export const DEFAULT_DATA_DIR = resolve(projectRoot, 'data');

/** Имя управляющей базы внутри каталога данных. */
export const CONTROL_DB_FILE = 'control.db';

/**
 * Каталог данных из окружения.
 *
 * Пустое значение — это незаданная переменная, а не путь: `??` ловит только
 * отсутствие, а `EDUKATOR_DATA_DIR=` уходило бы пустой строкой в `resolve` и
 * давало текущий рабочий каталог — то есть базы всех детей появлялись бы там,
 * откуда сервер запустили, и следующий запуск из другого места их не нашёл бы.
 */
export function dataDir(value: string | undefined = process.env.EDUKATOR_DATA_DIR): string {
  if (value === undefined || value.trim() === '') return DEFAULT_DATA_DIR;
  return resolve(value);
}

/** Путь управляющей базы внутри каталога данных. */
export function controlDatabasePath(dir: string = dataDir()): string {
  return resolve(dir, CONTROL_DB_FILE);
}

/**
 * Создаёт каталог данных вместе с `children/`. Оба сразу: детский каталог
 * понадобится первому же заведению, а `mkdir` под ним в этот момент был бы
 * отдельным местом отказа уже после того, как ребёнок заведён в `control.db`.
 */
export function ensureDataDir(dir: string = dataDir()): string {
  mkdirSync(resolve(dir, CHILDREN_DIR), { recursive: true });
  return dir;
}

/** Суффикс временного файла заведения. По нему же он и убирается на повторе. */
const TEMP_SUFFIX = '.tmp';

/**
 * Спутники WAL. Чистое закрытие соединения их снимает само, но обрыв процесса
 * посреди заведения оставляет: переносить в рабочее место их нельзя, иначе
 * рядом с новой базой лежал бы журнал от чужого файла.
 */
const WAL_SUFFIXES = ['-wal', '-shm'] as const;

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Исходная причина отказа важнее неудачной уборки.
  }
}

function removeDatabaseFiles(path: string): void {
  removeQuietly(path);
  for (const suffix of WAL_SUFFIXES) removeQuietly(`${path}${suffix}`);
}

/**
 * Убирает временные файлы прерванного заведения этого же ребёнка. Второй запуск
 * не продолжает чужую времянку: неизвестно, на каком шаге её бросили, и
 * домигрировать недописанный файл значило бы отдать ученику базу неизвестного
 * состояния. Продолжение здесь — это «начать временный файл заново», а не
 * «доверять оставшемуся».
 */
function dropStaleTemporaries(root: string, childId: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const prefix = `${childId}.db.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    // Спутники WAL временного файла заканчиваются на `-wal`/`-shm`, а не на
    // `.tmp`, поэтому проверяется вхождение суффикса, а не конец имени.
    if (!entry.includes(TEMP_SUFFIX)) continue;
    removeQuietly(resolve(root, entry));
  }
}

/** Открывает и сразу закрывает базу: миграция и `validateSchema` внутри. */
function prepareDatabase(path: string): void {
  const db = openDatabase(path);
  try {
    // WAL переносится в основной файл до `rename`: иначе схема осталась бы в
    // спутнике, который в рабочее место не едет.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export interface ProvisionChildResult {
  path: string;
  /** `false`, если база уже была на месте и заведение только доводилось до конца. */
  created: boolean;
}

/**
 * Заводит базу ребёнка по протоколу `provisioning` → `ready`.
 *
 * Порядок шагов задан сбоем питания: база собирается во временном файле,
 * сбрасывается на диск, попадает в рабочее место одним `rename` и только после
 * этого ребёнок объявляется `ready`. Обрыв на любом шаге оставляет ребёнка в
 * `provisioning` или `failed` — то есть невыдаваемым, — а повторный запуск
 * продолжает с той точки, где всё встало: недоделанная времянка убирается и
 * пишется заново, а уже переименованная база принимается как есть.
 *
 * Готовая база **не** пересоздаётся ни при каком статусе: за ней прогресс
 * ученика, и «завести заново» здесь означало бы его стереть.
 */
export function provisionChildDatabase(
  control: Database.Database,
  childId: string,
  dir: string = dataDir(),
): ProvisionChildResult {
  const child = readChild(control, childId);
  if (child === undefined) throw new Error(`Ребёнка ${childId} нет в управляющей базе`);
  if (child.retiredAt !== undefined) throw new Error(`Ребёнок ${childId} выведен`);

  const target = childDatabasePath(dir, childId);
  const root = dirname(target);
  let temp: string | undefined;
  try {
    mkdirSync(root, { recursive: true });

    if (existsSync(target)) {
      // Обрыв между `rename` и переводом в `ready`. Схема догоняется тем же
      // `openDatabase`: база могла приехать от прошлой версии приложения.
      prepareDatabase(target);
      if (child.status !== 'ready') markChildReady(control, childId);
      return { path: target, created: false };
    }

    dropStaleTemporaries(root, childId);
    temp = `${target}.${randomBytes(8).toString('hex')}${TEMP_SUFFIX}`;
    prepareDatabase(temp);
    const handle = openSync(temp, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, target);
    syncDirectory(target);
  } catch (error) {
    if (temp !== undefined) removeDatabaseFiles(temp);
    // Статус переводится в `failed` отдельно от причины: отказ самой пометки
    // (управляющая база тоже могла отвалиться) не имеет права заслонить то,
    // из-за чего заведение сорвалось. Пометка обязана стоять и на отказе до
    // первого файла: без неё ребёнок навсегда остался бы `provisioning`,
    // то есть молча ждал бы базы, которую никто не создаёт.
    try {
      markChildFailed(control, childId);
    } catch {
      // Причина уходит наружу исходной ошибкой.
    }
    throw error;
  }

  markChildReady(control, childId);
  return { path: target, created: true };
}
