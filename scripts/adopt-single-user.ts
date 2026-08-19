/**
 * Перенос однопользовательской базы в многоарендную: первый родитель, первый
 * ребёнок и **копия** нынешней `edukator.db` на месте его базы.
 *
 * Копия, а не перенос файла: оригинал остаётся откатом. Пока перенесённая база
 * не проверена живым занятием, единственный экземпляр прогресса за сорок часов
 * подготовки трогать нельзя — а `mv` не откатывается.
 *
 * Копирование идёт через `VACUUM INTO` (`server/backup.ts`): `cp` под WAL
 * уносит снимок без незакрытого журнала, то есть тихо теряет последние занятия.
 *
 * Протокол тот же, что у обычного заведения ребёнка: `provisioning` → база в
 * рабочем месте → `ready`. Оборванный перенос продолжается повторным запуском
 * с любого места — в том числе после обрыва между `rename` и `ready`, когда
 * база уже лежит на рабочем месте: копировать её заново незачем, повтор лишь
 * догоняет схему и ставит пометку. Отказ стоит только на уже `ready`-ребёнке:
 * он означает «база на месте и, возможно, в ней уже занимались», и повторный
 * перенос затёр бы её вчерашним снимком.
 *
 * Запуск:
 *   npm run adopt -- --email родитель@example.com --name Тимофей
 *   npm run adopt -- --email родитель@example.com --name Тимофей --from ./edukator.db
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  createChild,
  createParent,
  findParentByEmail,
  childDatabasePath,
  listChildren,
  openControlDatabase,
  type ChildSummary,
} from '../server/control-db.js';
import {
  controlDatabasePath,
  dataDir as resolveDataDir,
  ensureDataDir,
  provisionChildDatabase,
} from '../server/data-dir.js';
import { ADOPT_LOCK_OWNER, acquireDataLock } from '../server/data-lock.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * Где лежала база однопользовательского сервера: `EDUKATOR_DB` или
 * `edukator.db` в корне проекта. Знать об этой переменной теперь незачем
 * никому, кроме переноса, — поэтому она и осталась только здесь.
 */
export function legacyDatabasePath(value: string | undefined = process.env['EDUKATOR_DB']): string {
  if (value === undefined || value.trim() === '') return resolve(projectRoot, 'edukator.db');
  return resolve(value);
}

export interface AdoptOptions {
  /** Адрес первого родителя. Уже заведённый годится: перенос его не трогает. */
  email: string;
  /** Имя ребёнка. По нему же продолжается оборванный перенос. */
  name: string;
  /** Откуда переносим; по умолчанию прежняя `edukator.db`. */
  source?: string;
  dataDir?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface AdoptResult {
  parentId: string;
  childId: string;
  /** Путь заведённой базы ребёнка. */
  path: string;
  /** Родитель заведён этим запуском, а не найден по адресу. */
  parentCreated: boolean;
  /** Ребёнок заведён этим запуском; на продолжении оборванного — `false`. */
  childCreated: boolean;
}

/**
 * Ребёнок этого родителя с тем же именем — ключ продолжения. Выведенные не в
 * счёт: выведенный ребёнок с тем же именем значит «того переноса больше нет»,
 * и продолжать его некуда.
 */
function findChildByName(
  control: ReturnType<typeof openControlDatabase>,
  parentId: string,
  name: string,
): ChildSummary | undefined {
  const trimmed = name.trim();
  return listChildren(control, parentId).find((child) => child.name === trimmed);
}

/**
 * Сколько прогресса лежит в базе. Соединение голое и `readonly`: оригинал
 * перенос не трогает, а `openDatabase` завёл бы на нём WAL и прогнал миграцию.
 */
function progressOf(path: string): { runs: number; attempts: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const count = (table: 'runs' | 'attempts'): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { runs: count('runs'), attempts: count('attempts') };
  } finally {
    db.close();
  }
}

export function adoptSingleUser(options: AdoptOptions): AdoptResult {
  const source = resolve(options.source ?? legacyDatabasePath());
  if (!existsSync(source)) {
    throw new Error(`Базы ${source} нет: переносить нечего, укажите --from`);
  }
  const log = options.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = options.now ?? ((): Date => new Date());
  const dir = ensureDataDir(resolveDataDir(options.dataDir));

  // Замок берётся на весь перенос: живой сервер рядом успел бы открыть базу
  // ребёнка между `rename` и переводом в `ready` — то есть ровно ту, которую
  // перенос в этот момент ещё собирает.
  const lock = acquireDataLock(dir, ADOPT_LOCK_OWNER);
  try {
    const control = openControlDatabase(controlDatabasePath(dir));
    try {
      const known = findParentByEmail(control, options.email);
      if (known !== undefined && known.disabledAt !== undefined) {
        throw new Error(`Родитель ${known.email} отключён: перенос завёл бы ребёнка, которого не обслужат`);
      }
      const parentId = known?.id ?? createParent(control, options.email, now());
      const parentCreated = known === undefined;
      if (parentCreated) log(`родитель ${options.email} заведён: ${parentId}`);

      const existing = findChildByName(control, parentId, options.name);
      if (existing?.status === 'ready') {
        throw new Error(
          `Ребёнок ${existing.name} (${existing.id}) уже перенесён: повторный перенос затёр бы его прогресс`,
        );
      }
      const childId = existing?.id ?? createChild(control, parentId, options.name, now());
      const childCreated = existing === undefined;
      log(
        existing === undefined
          ? `ребёнок ${options.name} заведён: ${childId}`
          : `продолжается перенос ребёнка ${options.name} (${childId}, статус ${existing.status})`,
      );

      // Обрыв между `rename` и переводом в `ready` оставляет на месте целую
      // перенесённую базу при статусе `provisioning`/`failed`. С `source`
      // заведение такой файл принять отказывается — доказать, что это копия
      // исходной, а не заведённая рядом пустая, ему нечем, — и повторный
      // запуск упирался бы в отказ навсегда, хотя именно этот случай спека
      // называет продолжаемым. Доказательство даёт не файл, а реестр: строка
      // ребёнка уже была, каталог держит замок, а `ready` отсеян выше, — то
      // есть файл мог появиться только от прерванного переноса этого же
      // ребёнка. Поэтому продолжение идёт **без** `source`: копировать заново
      // нечего, остаётся догнать схему и пометить `ready`.
      const target = childDatabasePath(dir, childId);
      const resuming = existing !== undefined && existsSync(target);
      if (resuming) {
        // «Строка была, файл на месте» — ещё не доказательство, что файл наш:
        // детей заводит и экран семьи (`POST /api/family/children`), и его
        // заведение тоже проходит через `rename` до пометки `ready`. Совпади имя
        // — и продолжение приняло бы за перенос **пустую** заведённую базу:
        // перенос отчитался бы успехом, прогресс за сорок часов остался бы в
        // оригинале, а повторный запуск упёрся бы в отказ по `ready` навсегда.
        // Доказательство даёт содержимое: перенесённая копия несёт прогресс
        // оригинала целиком, заведённая рядом пустая — нет.
        const carried = progressOf(target);
        const original = progressOf(source);
        if (carried.runs < original.runs || carried.attempts < original.attempts) {
          throw new Error(
            `База ${target} уже на месте, но прогресса в ней меньше, чем в ${source} ` +
              `(забегов ${String(carried.runs)} против ${String(original.runs)}, ` +
              `попыток ${String(carried.attempts)} против ${String(original.attempts)}): ` +
              'это не прерванный перенос. Заведите ребёнка под другим именем ' +
              'либо разберитесь с базой на месте вручную',
          );
        }
        log(`база уже на месте (${target}): перенос продолжается без копирования`);
      }
      const result = provisionChildDatabase(control, childId, dir, resuming ? {} : { source });
      log(
        resuming
          ? `перенос завершён, база ${result.path} принята как есть`
          : `база перенесена в ${result.path}, оригинал ${source} не тронут`,
      );
      return { parentId, childId, path: result.path, parentCreated, childCreated };
    } finally {
      control.close();
    }
  } finally {
    lock.release();
  }
}

export interface AdoptArgs {
  email: string;
  name: string;
  source?: string;
  dataDir?: string;
}

export function parseArgs(argv: string[]): AdoptArgs {
  const values = new Map<string, string>();
  const known = new Set(['email', 'name', 'from', 'data-dir']);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);
    if (!known.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    // Пустое значение не «не задано»: `--from ''` превратился бы в каталог
    // запуска, а `--name ''` — в ребёнка без имени.
    if (value.trim() === '') throw new Error(`У флага ${flag} пустое значение`);
    values.set(name, value);
    index += 1;
  }

  const email = values.get('email');
  if (email === undefined) throw new Error('Не указан --email: без родителя ребёнка не завести');
  const name = values.get('name');
  if (name === undefined) throw new Error('Не указано --name: имя ребёнка обязательно');
  const from = values.get('from');
  const dir = values.get('data-dir');
  return {
    email,
    name,
    ...(from === undefined ? {} : { source: resolve(from) }),
    ...(dir === undefined ? {} : { dataDir: resolve(dir) }),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = adoptSingleUser(args);
  process.stdout.write(
    `adopt: ребёнок ${result.childId} готов, родитель ${result.parentId}\n` +
      'дальше: npm run parent -- invite --email <адрес>, затем ссылка устройству из родительского экрана\n',
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`adopt: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
