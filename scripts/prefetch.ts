/**
 * Опережающее наполнение банка заданий: тот же цикл, что крутит воркер, но
 * запущенный руками и с ограничением числа батчей. Нужен в двух случаях —
 * перед занятием, когда очередь заведомо холодная, и при сборке посевного
 * банка, который потом коммитится в `content/seed-bank/`.
 *
 * Это единственная точка, где codex зовётся по-настоящему ради заданий: тесты
 * его не вызывают никогда.
 *
 * Кого греть, указывается всегда: баз у сервера столько, сколько детей, и
 * умолчание грело бы очередь не того ученика, который сядет заниматься.
 *
 * Запуск:
 *   npm run prefetch -- --child <id>                  # погреть ближайшие темы ребёнка
 *   npm run prefetch -- --all                         # всех готовых детей подряд
 *   npm run prefetch -- --child <id> --topics 12 --target 10   # шире и глубже
 *   npm run prefetch -- --child <id> --target 10 --threshold 10 # и уже тёплые темы
 *   npm run prefetch -- --child <id> --export         # выгрузить банк в посев
 *
 * Тема доливается, только пока её остаток ниже порога (`--threshold`, по
 * умолчанию `REFILL_BELOW`), поэтому один `--target` глубже уже тёплые темы не
 * копает: поднимать надо оба.
 *
 * Прогрев берёт замок каталога данных и при живом сервере отказывается: предел
 * одновременных вызовов codex процессный, и второй процесс на том же каталоге
 * завёл бы вторую пару слотов — занятие ученика встало бы в очередь за
 * прогревом (см. `server/data-lock.ts`).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, SUBJECTS, type Subject } from '../server/db.js';
import { writeFileAtomic } from '../server/atomic-write.js';
import {
  childDatabasePath,
  isChildServiceable,
  listServiceableChildren,
  openControlDatabase,
  readChild,
} from '../server/control-db.js';
import { controlDatabasePath, dataDir as resolveDataDir } from '../server/data-dir.js';
import { acquireDataLock, DataLockBusyError, PREFETCH_LOCK_OWNER } from '../server/data-lock.js';
import { CURRICULUM_DIR, loadCurriculum, syncTopicState } from '../server/curriculum.js';
import type { CodexRunner } from '../server/codex/client.js';
import {
  collectSeedTasks,
  formatSeedBank,
  loadSeedBank,
  seedBankPath,
  SeedBankError,
  SEED_BANK_DIR,
  type LoadSeedBankResult,
  type SeedTopic,
} from '../server/codex/seed-bank.js';
import {
  everyRefillFailed,
  REFILL_BELOW,
  runWarmupCycle,
  type CycleReport,
  type TaskProducer,
  type WorkerLog,
} from '../server/codex/worker.js';

export interface PrefetchOptions {
  /** Сколько ближайших тем плана греть; по умолчанию столько же, сколько у воркера. */
  topics?: number;
  /** Запас заданий на тему. */
  target?: number;
  /**
   * Остаток, ниже которого тема доливается; по умолчанию воркерский
   * `REFILL_BELOW`. Свой флаг нужен, потому что порог обязан быть не выше
   * запаса: без него `--target 2` упирался бы в отказ воркера, называя число,
   * которое из командной строки задать нечем.
   */
  threshold?: number;
  /** Потолок батчей на тему за цикл: он и есть «ограничение числа батчей». */
  batches?: number;
  /** Сколько циклов пополнения прогнать подряд; между ними план пересчитывается. */
  cycles?: number;
  /**
   * Одна модель сразу на генератор и на проверяющего; по умолчанию каждый
   * берёт модель своей роли (`EDUKATOR_MODEL_GENERATE`, `_VALIDATE`).
   */
  model?: string;
  /** Выгрузить содержимое банка в посевные файлы после наполнения. */
  exportSeed?: boolean;
  /** Куда выгружать посев; по умолчанию `content/seed-bank`. */
  outDir?: string;
  /** Откуда подгружать посев перед наполнением. */
  seedDir?: string;
  /**
   * База, которую греем. Обязательна: единой базы у сервера больше нет. Из
   * командной строки её не задают — путь собирает `prefetchChildren` по
   * выбранному ребёнку, чтобы греть было нечего мимо реестра арендаторов.
   */
  dbPath?: string;
  curriculumDir?: string;
  /** Подменяемый производитель заданий: тесты не запускают процессов. */
  produce?: TaskProducer;
  /** Подменяемый вызов codex. */
  run?: CodexRunner;
  log?: WorkerLog;
}

export interface PrefetchResult {
  /** Отчёты по циклам в порядке выполнения. */
  cycles: CycleReport[];
  seeded: LoadSeedBankResult;
  /** Пути выгруженных посевных файлов; пусто без `--export`. */
  exported: string[];
  /**
   * Предметы, снимок которых выгрузить не вышло: битая строка банка, отказ
   * записи, непрочитанный посев. Отдельно от пропущенных по осторожности (пустой
   * банк, чужой снимок на месте выгрузки) — те не ошибка, а эти обязаны красить
   * прогон.
   */
  exportFailed: Subject[];
}

export interface PrefetchChildrenOptions extends Omit<PrefetchOptions, 'dbPath'> {
  /** Каталог данных; по умолчанию тот же, что у сервера (`EDUKATOR_DATA_DIR`). */
  dataDir?: string;
  /** Кого греть. Либо он, либо `allChildren` — умолчания нет намеренно. */
  childId?: string;
  /** Греть всех обслуживаемых детей подряд. */
  allChildren?: boolean;
}

/** Итог прогрева одного ребёнка: тот же отчёт плюс его имя в реестре. */
export interface ChildPrefetchResult extends PrefetchResult {
  childId: string;
}

export interface PrefetchChildrenResult {
  children: ChildPrefetchResult[];
}

export const DEFAULT_CYCLES = 1;

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Греет очередь и, если попросили, выгружает получившийся банк в посев.
 *
 * Циклы идут подряд, а не параллельно: внутри цикла своя очередь с пределом
 * одновременных вызовов codex, и запускать несколько циклов сразу значило бы
 * этот предел обойти.
 */
export async function prefetch(options: PrefetchOptions = {}): Promise<PrefetchResult> {
  const cycles = options.cycles ?? DEFAULT_CYCLES;
  if (!Number.isInteger(cycles) || cycles < 1) {
    throw new Error(`Число циклов должно быть положительным целым, получено ${cycles}`);
  }

  // Порог по умолчанию прижимается к запасу: воркер отвергает порог выше
  // запаса, и `--target 2` иначе падал бы на умолчании `REFILL_BELOW = 4` уже
  // после того, как посев записан в базу. Заданный руками порог не трогается —
  // пусть отказ воркера назовёт именно то, что попросили.
  const threshold =
    options.threshold ?? (options.target === undefined ? undefined : Math.min(REFILL_BELOW, options.target));

  const log = options.log ?? defaultLog;
  const graph = loadCurriculum(options.curriculumDir ?? CURRICULUM_DIR);
  if (options.dbPath === undefined || options.dbPath.trim() === '') {
    throw new Error('Прогрев не знает, какую базу греть: путь ребёнка не задан');
  }
  const db = openDatabase(options.dbPath);

  try {
    syncTopicState(db, graph);
    // Порча посева не должна останавливать наполнение: генерация от него не
    // зависит, а `prefetch` — единственный способ греть очередь, и одна битая
    // тема в `content/seed-bank/*.json` иначе блокировала бы его целиком. Так
    // же поступает старт сервера (`trySeedBank` в `server/index.ts`).
    let seeded: LoadSeedBankResult = { loaded: 0, skipped: 0, missing: [] };
    // Предметы, посев которых до банка не доехал: их выгрузка не трогает.
    const brokenSeed = new Set<string>();
    try {
      seeded = loadSeedBank(db, graph, {
        ...(options.seedDir === undefined ? {} : { dir: options.seedDir }),
      });
    } catch (error) {
      log(`посев не загружен: ${(error as Error).message}`);
      // Виновных предметов ошибка не назвала — значит, сорвалось до обхода, и
      // про любой из них известно одно: посев в базу не попал. Частичный итог
      // `SeedBankError` при этом сохраняется: здоровые предметы доехали, и
      // выгрузке важно, у каких из них файла не было вовсе.
      const affected = error instanceof SeedBankError ? error.subjects : SUBJECTS;
      if (error instanceof SeedBankError) seeded = error.result;
      for (const subject of affected) brokenSeed.add(subject);
    }
    if (seeded.loaded > 0) log(`посев: добавлено ${seeded.loaded} задани(й)`);
    // Предмет без исходного файла загружен не был — в банке одно
    // нагенерированное, ровно как у непрочитанного.
    const missingSeed = new Set<string>(seeded.missing);

    const reports: CycleReport[] = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const report = await runWarmupCycle({
        db,
        graph,
        log,
        ...(options.topics === undefined ? {} : { topics: options.topics }),
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(threshold === undefined ? {} : { threshold }),
        ...(options.batches === undefined ? {} : { maxBatches: options.batches }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.produce === undefined ? {} : { produce: options.produce }),
        ...(options.run === undefined ? {} : { run: options.run }),
      });
      reports.push(report);

      for (const refill of report.refilled) {
        log(
          `цикл ${cycle}: тема «${refill.topicId}» — ${refill.stored} новых, ` +
            `остаток ${refill.available}${refill.error === undefined ? '' : `, ошибка: ${refill.error}`}`,
        );
      }
      // Дальше пойдут те же темы с тем же результатом: codex не вернётся между
      // циклами, а ждать его тут, в ручном запуске, незачем.
      if (report.codexUnavailable) {
        log('цикл пополнения прерван: codex недоступен');
        break;
      }
      // Та же остановка по второму признаку, что и у воркера: просроченная
      // авторизация, кончившаяся квота и обрыв сети приезжают `CodexRunError` и
      // до `codexUnavailable` не доходят. Без этого `--cycles 3` трижды
      // прогоняет все голодные темы по десять минут на вызов, зная заранее, что
      // ни одна не долилась.
      if (everyRefillFailed(report)) {
        log(
          `цикл пополнения прерван: ни одна из ${report.refilled.length} голодных тем не пополнена`,
        );
        break;
      }
    }

    const exported: string[] = [];
    const exportFailed: Subject[] = [];
    if (options.exportSeed === true) {
      const outDir = options.outDir ?? SEED_BANK_DIR;
      mkdirSync(outDir, { recursive: true });
      for (const subject of SUBJECTS) {
        const path = seedBankPath(subject, outDir);
        // Предмет с непрочитанным посевом не выгружается вовсе, даже когда
        // задания в банке есть: в нём лежит не снимок, а огрызок — то, что
        // успели нагенерировать циклы поверх незагруженного файла. Проверки на
        // пустоту тут мало: переименованная в карте тема роняет разбор всего
        // файла, а один долитый батч делает предмет непустым, и снимок из
        // полусотни заданий молча сменился бы пятью.
        //
        // Пропуск красит прогон: непрочитанный посев — ошибка, а `--export`
        // зовут ради файлов, и «выгружено 2 файла» с нулём на выходе неотличимо
        // от полной выгрузки. Молча устаревший снимок заметить нечем.
        if (brokenSeed.has(subject)) {
          log(`посев ${subject}: файл не загрузился, ${path} не переписан`);
          exportFailed.push(subject);
          continue;
        }
        // Исходного файла не было, а по пути выгрузки чужой снимок лежит: это
        // `--seed-dir` мимо `--out`, и в базе опять же огрызок — то, что успели
        // нагенерировать циклы. Когда файла нет и там, писать нечего поверх, и
        // выгрузка создаёт его, ради чего её и зовут в первый раз.
        if (missingSeed.has(subject) && existsSync(path)) {
          log(`посев ${subject}: исходного файла не было, ${path} не переписан`);
          exportFailed.push(subject);
          continue;
        }
        let topics: SeedTopic[];
        try {
          topics = collectSeedTasks(db, graph, subject);
        } catch (error) {
          // Битая строка банка (пустой `hint`, нечитаемый `accept[]`) — беда
          // одного предмета. Обрыв всей выгрузки на ней оставлял бы половину
          // снимков обновлённой, а половину прежней: набор файлов в репозитории
          // перестал бы быть одним снимком банка.
          log(`посев ${subject}: снимок не собрался, ${path} не переписан: ${(error as Error).message}`);
          exportFailed.push(subject);
          continue;
        }
        // Пустой предмет не выгружается по той же причине: в базе может не быть
        // ни одного его задания (чужой ребёнок в `--child`, ничего не давший цикл), а
        // записав пустой файл, экспорт уничтожил бы ровно тот снимок, который
        // должен был обновить.
        if (topics.length === 0) {
          log(`посев ${subject}: в банке нет заданий, ${path} не переписан`);
          exportFailed.push(subject);
          continue;
        }
        // Через временный файл: посев — снимок для первого запуска и отката, и
        // оборванная на середине запись оставила бы вместо него битый JSON.
        try {
          writeFileAtomic(path, formatSeedBank(subject, topics));
        } catch (error) {
          // Отказ записи — беда того же одного предмета, что и битая строка
          // банка: каталог на месте файла, права, кончившееся место. Обрыв
          // выгрузки здесь тем более заметен — часть снимков уже переписана.
          log(`посев ${subject}: снимок не записан в ${path}: ${(error as Error).message}`);
          exportFailed.push(subject);
          continue;
        }
        exported.push(path);
        const count = topics.reduce((sum, entry) => sum + entry.tasks.length, 0);
        log(`посев ${subject}: ${count} задани(й) в ${topics.length} теме(ах) → ${path}`);
      }
    }

    return { cycles: reports, seeded, exported, exportFailed };
  } finally {
    db.close();
  }
}

/**
 * Греет очередь выбранных детей.
 *
 * Здесь и только здесь берётся замок каталога данных: греть можно лишь пока
 * сервера нет. Предел одновременных вызовов codex живёт в памяти процесса
 * (`server/codex/concurrency.ts`), так что запущенный руками прогрев поверх
 * живого сервера — это вторая пара слотов, и ответ ученика встаёт в очередь за
 * фоновой генерацией.
 *
 * Дети обходятся подряд, а не разом: у прогрева одна пара слотов на всех, и
 * параллельный обход отличался бы от последовательного только тем, что первый
 * ребёнок ждал бы дольше.
 */
export async function prefetchChildren(
  options: PrefetchChildrenOptions = {},
): Promise<PrefetchChildrenResult> {
  const { dataDir: requestedDir, childId, allChildren, ...shared } = options;
  const log = options.log ?? defaultLog;

  // Ни того ни другого — самая опасная опечатка: молча греть первого попавшегося
  // ребёнка прогрев права не имеет, очередь нужна тому, кто сядет заниматься.
  if (childId === undefined && allChildren !== true) {
    throw new Error('Укажите, кого греть: --child <id> или --all');
  }
  if (childId !== undefined && allChildren === true) {
    throw new Error('--child и --all вместе не имеют смысла: выберите одно');
  }
  // Снимок посева один на репозиторий, а собирается он из банка одной базы:
  // `--all --export` переписывал бы его каждым следующим ребёнком, и в файлах
  // остался бы банк последнего.
  if (allChildren === true && options.exportSeed === true) {
    throw new Error('--export требует одного ребёнка: снимок посева собирается из одной базы');
  }

  const dir = resolveDataDir(requestedDir);
  let lock;
  try {
    lock = acquireDataLock(dir, PREFETCH_LOCK_OWNER);
  } catch (error) {
    if (error instanceof DataLockBusyError) {
      throw new Error(
        `${error.message}. Ручной прогрев при живом сервере завёл бы вторую пару ` +
          'слотов codex: остановите сервер и повторите',
      );
    }
    throw error;
  }

  try {
    const control = openControlDatabase(controlDatabasePath(dir));
    let children: string[];
    try {
      if (childId === undefined) {
        children = listServiceableChildren(control).map((child) => child.id);
        if (children.length === 0) {
          throw new Error(`В каталоге ${dir} нет ни одного готового ребёнка`);
        }
      } else {
        const child = readChild(control, childId);
        if (child === undefined) throw new Error(`Ребёнка ${childId} нет в управляющей базе`);
        // Статус называется целиком: `provisioning` значит «база ещё не
        // заведена», и греть по этому пути значило бы создать чужой файл рядом.
        if (!isChildServiceable(child)) {
          throw new Error(
            `Ребёнок ${childId} не готов к прогреву: статус ${child.status}` +
              (child.retiredAt === undefined ? '' : ', выведен'),
          );
        }
        children = [child.id];
      }
    } finally {
      control.close();
    }

    const results: ChildPrefetchResult[] = [];
    for (const id of children) {
      log(`прогрев ребёнка ${id}`);
      const result = await prefetch({ ...shared, dbPath: childDatabasePath(dir, id) });
      results.push({ childId: id, ...result });
    }
    return { children: results };
  } finally {
    lock.release();
  }
}

/**
 * Счётчик из командной строки. Одного `/^\d+$/` мало: ему подходит и
 * «99999999999999999999», а это `1e20` настоящих вызовов codex по десять минут
 * каждый — от опечатки такой запуск неотличим до самого утра. Ноль тоже не
 * значение: цикл с ним ничего не делает и молча отчитывается «0 новых заданий».
 */
function isPositiveCount(value: string): boolean {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 1;
}

const NUMERIC_FLAGS = ['topics', 'target', 'threshold', 'batches', 'cycles'] as const;
const TEXT_FLAGS = ['model', 'out', 'seed-dir', 'child', 'data-dir', 'curriculum'] as const;
const BOOLEAN_FLAGS = ['export', 'all'] as const;

export function parseArgs(argv: string[]): PrefetchChildrenOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const numeric = new Set<string>(NUMERIC_FLAGS);
  const text = new Set<string>(TEXT_FLAGS);
  const boolean = new Set<string>(BOOLEAN_FLAGS);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);

    if (boolean.has(name)) {
      if (flags.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
      flags.add(name);
      continue;
    }
    if (!numeric.has(name) && !text.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);

    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    if (numeric.has(name) && !isPositiveCount(value)) {
      throw new Error(`${flag} ожидает целое число не меньше 1, получено «${value}»`);
    }
    // Пустое значение молча доезжает до места применения и там значит совсем не
    // «не задано»: `--model ''` уходит в codex как `-m ''` (умолчание берётся по
    // `??`, а пустая строка не `undefined`), и каждый батч падает уже в модели с
    // невнятной причиной. Так же `--data-dir ''` превратился бы в путь до
    // текущего каталога.
    if (text.has(name) && value.trim() === '') {
      throw new Error(`У флага ${flag} пустое значение`);
    }
    values.set(name, value);
    index += 1;
  }

  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    return raw === undefined ? undefined : Number(raw);
  };
  const path = (name: string): string | undefined => {
    const raw = values.get(name);
    return raw === undefined ? undefined : resolve(raw);
  };

  const topics = number('topics');
  const target = number('target');
  const threshold = number('threshold');
  const batches = number('batches');
  const cycles = number('cycles');
  const model = values.get('model');
  const outDir = path('out');
  const seedDir = path('seed-dir');
  const childId = values.get('child');
  const dataDir = path('data-dir');
  const curriculumDir = path('curriculum');

  return {
    ...(topics === undefined ? {} : { topics }),
    ...(target === undefined ? {} : { target }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(batches === undefined ? {} : { batches }),
    ...(cycles === undefined ? {} : { cycles }),
    ...(model === undefined ? {} : { model }),
    ...(flags.has('export') ? { exportSeed: true } : {}),
    ...(outDir === undefined ? {} : { outDir }),
    ...(seedDir === undefined ? {} : { seedDir }),
    ...(childId === undefined ? {} : { childId }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(flags.has('all') ? { allChildren: true } : {}),
    ...(curriculumDir === undefined ? {} : { curriculumDir }),
  };
}

/** Сколько заданий прогон добавил в банк за все циклы. */
function storedTotal(result: PrefetchResult): number {
  return result.cycles.reduce(
    (sum, cycle) => sum + cycle.refilled.reduce((inner, refill) => inner + refill.stored, 0),
    0,
  );
}

/**
 * Провалившийся прогон: codex не запускается, прогон целиком не дал ни одного
 * задания либо снимок предмета не собрался. Нужен ради кода возврата —
 * `prefetch` зовут из `&&`-цепочек и заданий по расписанию, а «0 новых заданий»
 * с нулём на выходе там неотличимо от «всё уже тёплое». Частичная неудача
 * (часть тем упала) успехом остаётся: очередь всё-таки пополнилась. Сорванная
 * выгрузка — нет: её зовут именно ради файлов, и молча недописанный снимок
 * заметить нечем.
 *
 * `everyRefillFailed` спрашивается по прогону, а не по каждому циклу: тема,
 * долитая в первом цикле, во втором уже тёплая и в голодные не попадает, так
 * что к последнему циклу в них остаются ровно нерешаемые — и признак «ни одна
 * голодная тема не пополнена» становится истинным на удачном прогоне. Так
 * `--cycles 2` выходил единицей, добавив полсотни заданий, то есть ломал ту
 * самую `&&`-цепочку, ради которой признак и заведён.
 */
export function prefetchFailed(result: PrefetchResult): boolean {
  return (
    result.exportFailed.length > 0 ||
    result.cycles.some((cycle) => cycle.codexUnavailable) ||
    (storedTotal(result) === 0 && result.cycles.some(everyRefillFailed))
  );
}

/**
 * Провалившийся обход: хотя бы один ребёнок не догрелся. Мягче нельзя —
 * `--all` зовут перед занятием всей семьи, и «двое из трёх» здесь значит, что
 * третий сядет за пустую очередь.
 */
export function prefetchChildrenFailed(result: PrefetchChildrenResult): boolean {
  return result.children.some(prefetchFailed);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await prefetchChildren(options);

  for (const child of result.children) {
    const stored = storedTotal(child);
    // Итог выгрузки печатается всегда, когда её просили, — в том числе нулевой:
    // пропуск предмета по осторожности («исходного файла не было, чужой снимок на
    // месте») красит прогон, но без итоговой строки `--export` всё равно выглядел
    // бы сработавшим, пока диагностику конкретного предмета не заметили в логе.
    const exportSummary =
      options.exportSeed === true
        ? `, посев выгружен в ${child.exported.length} файл(ов)` +
          (child.exportFailed.length === 0 ? '' : `, не выгружен: ${child.exportFailed.join(', ')}`)
        : '';
    process.stdout.write(
      `prefetch ${child.childId}: ${stored} новых задани(й) за ` +
        `${child.cycles.length} цикл(ов)${exportSummary}\n`,
    );
  }

  if (prefetchChildrenFailed(result)) {
    process.stderr.write('prefetch: наполнение не удалось, подробности выше\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`prefetch: ${error.message}\n`);
    process.exitCode = 1;
  });
}
