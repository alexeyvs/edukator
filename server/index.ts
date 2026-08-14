import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { databasePath, openDatabase } from './db.js';
import {
  CURRICULUM_DIR,
  loadCurriculum,
  syncTopicState,
  type SyncResult,
  type TopicGraph,
} from './curriculum.js';
import { loadSeedBank, SeedBankError, type LoadSeedBankResult } from './codex/seed-bank.js';
import {
  registerSessionRoutes,
  registerUnavailableSession,
  type SessionRoutesOptions,
} from './routes/session.js';
import { registerRunRoutes, registerUnavailableRun } from './routes/run.js';
import {
  registerTriageRoutes,
  registerUnavailableTriage,
} from './routes/triage.js';
import { registerProfileRoutes, registerUnavailableProfile } from './routes/profile.js';
import { registerBossRoutes, registerUnavailableBoss } from './routes/boss.js';
import { registerParentsRoutes, registerUnavailableParents } from './routes/parents.js';
import { registerLearningRoutes, registerUnavailableLearning } from './routes/learning.js';
import { registerGateRoutes, registerUnavailableGate } from './routes/gate.js';
import { codexConcurrency, disputeConcurrency, type CodexConcurrency } from './codex/concurrency.js';
import { startWorker, type StartWorkerOptions, type WorkerHandle } from './codex/worker.js';
import { readParentPin } from './parent-pin.js';

export { databasePath };

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
export const WEB_DIST_DIR = resolve(projectRoot, 'web', 'dist');

/**
 * Версия приложения из package.json — отдаётся в /api/health. Нечитаемый или
 * битый файл роняет не запрос, а только само поле: маршрут здоровья читают,
 * чтобы узнать причину поломки, и 500 вместо «database: error» её как раз прячет.
 */
export function readVersion(): string {
  try {
    const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch (error) {
    process.stderr.write(`версия не прочитана из package.json: ${(error as Error).message}\n`);
    return '0.0.0';
  }
}

export type DatabaseStatus = 'ok' | 'error';

/**
 * Проверка живости базы: открыть, домигрировать до текущей схемы и выполнить
 * тривиальный запрос. Дешёвой её называть нельзя — `validateSchema` заодно
 * гоняет `quick_check` по всем страницам, — поэтому повторно за запрос она
 * вызывается только на восстановлении после неудачного старта. Синхронизация
 * карты тем открывает базу своим соединением и тот же `quick_check` повторяет:
 * опрос здоровья стоит двух проходов по файлу, и это осознанная плата за то,
 * что занятие не делит соединение с health.
 *
 * Причина отказа уходит в stderr: логгер Fastify выключен, а «database: error»
 * без текста не отличает занятый файл от непрочитанной схемы — а читают health
 * ровно тогда, когда это и надо различить.
 */
export function checkDatabase(path: string = databasePath()): DatabaseStatus {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    // `fileMustExist` проверяется атомарно самим SQLite: отдельный existsSync
    // оставлял окно, в котором пропавший файл успевал создаться заново.
    db = openDatabase(path, { fileMustExist: true });
    db.prepare('SELECT 1').get();
    return 'ok';
  } catch (error) {
    process.stderr.write(`база ${path} недоступна: ${(error as Error).message}\n`);
    return 'error';
  } finally {
    db?.close();
  }
}

/**
 * Отпечаток файла базы: устройство и inode. Нужен, чтобы отличить тот файл, с
 * которым занятие открыло соединение при старте, от положенного на его место
 * другого. Иначе подмену не заметить вовсе: по отвязанному файлу отвечает не
 * только `SELECT 1` — под WAL проходит и запись. `SQLITE_FCNTL_HAS_MOVED`, из-за
 * которого в журнальном режиме была бы `SQLITE_READONLY_DBMOVED`, при WAL не
 * спрашивают, так что транзакция завершается успехом, а её данные остаются в
 * файле, которого по пути базы больше нет (проверено на нашем `openDatabase`).
 * Молчаливая потеря и есть причина держать отпечаток руками.
 *
 * `undefined` — файла нет или он не читается; такой ответ значит «сверять не с
 * чем», а не «тот же самый».
 */
function fileIdentity(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
}

/** Соединение занятия вместе с отпечатком файла, к которому оно привязано. */
export interface SessionDatabase {
  db: ReturnType<typeof openDatabase>;
  file: string;
}

/**
 * Открывает соединение занятия и снимает отпечаток файла **до и после**
 * открытия. Одного замера после открытия мало: подмена файла ровно в это окно
 * привязывает соединение к прежнему inode, а в отпечаток кладёт уже новый — тот
 * самый, что health и увидит по пути базы. Сверка совпала бы навсегда, и health
 * до перезапуска отвечал бы 200 занятию, чьи записи уходят в отвязанный файл.
 * Пропавший перед открытием файл (`before === undefined`) — тот же случай, и
 * открытие до него даже не доходит: `openDatabase` завёл бы пустую базу на
 * месте потерянной, а она переживает отказ занятия. Health по ней отвечает
 * «ok», следующий запуск поднимается зелёным — и потеря всего прогресса
 * выглядит здоровьем. По той же причине открытие идёт с `fileMustExist`: файл
 * может пропасть и между замером и открытием, а этот запрет проверяет сам
 * SQLite, атомарно с открытием.
 *
 * Расхождение замеров значит «связь соединения с файлом не подтверждена»:
 * соединение закрывается, занятие не поднимается — как и при недоступной базе.
 * Отказ самого открытия пролетает наверх: его причину печатает вызывающий.
 *
 * Проверка остаётся вероятностной, и точнее её здесь не сделать. Замена вида
 * A→B→A целиком внутри окна открытия (файл подменили и вернули прежний обратно)
 * даёт совпадение замеров при соединении с B. Закрыть эту дыру можно было бы
 * только отпечатком того файла, который открыл сам SQLite, а он наружу не
 * выведен: `better-sqlite3` не отдаёт дескриптор, `PRAGMA database_list` знает
 * лишь путь, и пробной записью подмену не поймать — под WAL она проходит без
 * ошибки (см. `fileIdentity`). Договориться с тем, кто подменяет файл, тоже
 * нельзя: это человек с `cp` мимо всякой блокировки.
 */
export function openSessionDatabase(
  path: string,
  open: (target: string) => ReturnType<typeof openDatabase> = (target) =>
    openDatabase(target, { fileMustExist: true }),
): SessionDatabase | undefined {
  const before = fileIdentity(path);
  if (before === undefined) return undefined;
  const db = open(path);
  const after = fileIdentity(path);
  if (after === before) return { db, file: before };

  // Уборка в своём `try`: отказ закрытия не имеет права заслонить причину.
  try {
    db.close();
  } catch (error) {
    process.stderr.write(`соединение занятия не закрыто: ${(error as Error).message}\n`);
  }
  return undefined;
}

/**
 * Заводит в `topic_state` темы, которых там ещё нет (спека: «при старте сервера
 * отсутствующие темы заводятся с нулевыми значениями»). Без этого планировщик
 * считает недостающую строку нулевым состоянием и спокойно ставит тему в план,
 * а `recordAttempt` на первом же ответе по ней падает.
 */
export function syncCurriculumState(
  path: string = databasePath(),
  curriculumDir: string = CURRICULUM_DIR,
): SyncResult {
  return syncLoadedCurriculum(path, loadCurriculum(curriculumDir));
}

/**
 * Заливает посевной банк в `task_bank`. Идемпотентна: повторный запуск ничего
 * не добавляет — задания отсекаются по отпечатку формулировки. Вызывается один
 * раз за старт, после того как темы заведены: без строк `topic_state` вставка
 * упала бы на внешнем ключе.
 */
export function loadSeedTasks(
  path: string,
  graph: TopicGraph,
  seedDir?: string,
): LoadSeedBankResult {
  const db = openDatabase(path);
  try {
    return loadSeedBank(db, graph, seedDir === undefined ? {} : { dir: seedDir });
  } finally {
    db.close();
  }
}

function syncLoadedCurriculum(path: string, graph: TopicGraph): SyncResult {
  const db = openDatabase(path);
  try {
    const result = syncTopicState(db, graph);

    // Осиротевшие строки не удаляются (тема может вернуться в карту), но и
    // молчать о них нельзя: обычно это переименованный `id`, то есть прогресс,
    // который больше никогда не попадёт ни в план, ни в прогноз.
    if (result.stale.length > 0) {
      process.stderr.write(
        `в topic_state есть состояния без темы в карте: ${result.stale.join(', ')}\n`,
      );
    }

    return result;
  } finally {
    db.close();
  }
}

/** Адрес по умолчанию; скрипт рабочего запуска переопределяет его через `HOST`. */
export const HOST = '0.0.0.0';

/** Порт по умолчанию; переопределяется переменной `PORT` (см. `readPort`). */
export const DEFAULT_PORT = 3000;

export type CurriculumStatus = 'ok' | 'error';

/** Настройки занятия, которые тесты подменяют: разбирающий спор и запуск фона. */
export type ServerOptions = Omit<SessionRoutesOptions, 'db' | 'graph' | 'available'> & {
  /** Подменяется только в тестах ошибочной конфигурации. */
  personaPath?: string;
  /** Подмена настроек воркера в тестах; false отключает его для служебного сервера. */
  worker?: false | Omit<StartWorkerOptions, 'db' | 'graph' | 'budget'>;
  /** Подменяемый бюджет фонового воркера. */
  codexBudget?: CodexConcurrency;
  /** false оставляет статику Vite dev-серверу; строка подменяет каталог в тестах. */
  webDist?: string | false;
  /** Явная подмена родительского PIN для HTTP-тестов. */
  parentPin?: string;
};

export function buildServer(
  curriculumDir: string = CURRICULUM_DIR,
  options: ServerOptions = {},
): FastifyInstance {
  const parentPin = readParentPin(options.parentPin ?? process.env.EDUKATOR_PARENT_PIN);
  const webDist = options.webDist
    ?? (process.env.EDUKATOR_WEB_DEV === '1' ? false : WEB_DIST_DIR);
  if (webDist !== false) {
    try {
      if (!statSync(webDist).isDirectory()) throw new Error('не каталог');
      if (!statSync(resolve(webDist, 'index.html')).isFile()) throw new Error('нет index.html');
    } catch {
      throw new Error(
        `интерфейс не собран в ${webDist}; выполните npm run build:web`,
      );
    }
  }

  const app = Fastify({ logger: false });

  // Fastify по умолчанию отдаёт текст исключения в теле ответа, а внутренние
  // ошибки называют абсолютные пути и содержимое базы. Сервер слушает всю
  // домашнюю сеть без пароля, так что наружу уходит только факт поломки, а
  // подробности — в stderr. Отказы самого Fastify (битый JSON в теле — 400)
  // остаются как есть: они про запрос, а не про внутренности.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.message });

    process.stderr.write(`${request.method} ${request.url}: ${error.message}\n`);
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  let curriculum: CurriculumStatus = 'ok';
  let graph: TopicGraph | undefined;
  let curriculumSynchronized = false;

  // Непрочитанная карта тем не должна мешать серверу подняться: иначе
  // /api/health — единственное, что умеет назвать причину поломки — становится
  // недоступен ровно в тот раз, когда он и нужен.
  try {
    graph = loadCurriculum(curriculumDir);
  } catch (error) {
    curriculum = 'error';
    process.stderr.write(`карта тем не загружена: ${(error as Error).message}\n`);
  }

  function trySyncCurriculum(): boolean {
    if (graph === undefined) return false;
    try {
      syncLoadedCurriculum(databasePath(), graph);
      curriculumSynchronized = true;
      return true;
    } catch (error) {
      process.stderr.write(`синхронизация карты тем не выполнена: ${(error as Error).message}\n`);
      return false;
    }
  }

  // Посев заливается один раз за старт, а не на каждом /api/health: он
  // идемпотентен, но разбирать три файла и биться об уникальный индекс на
  // каждом опросе здоровья незачем. Отсутствие или порча посева сервер не
  // роняет — без него приложение работает, просто первая тема холодная.
  function trySeedBank(): void {
    if (graph === undefined) return;
    try {
      const seeded = loadSeedTasks(databasePath(), graph, options.seedDir);
      if (seeded.loaded > 0) {
        process.stderr.write(`посевной банк: добавлено ${seeded.loaded} задани(й)\n`);
      }
    } catch (error) {
      // Частичный итог печатается вместе с причиной: порча одной записи не
      // отменяет остальные, и «посевной банк не загружен» без числа заданий
      // читалось бы как «не загружено ничего».
      const loaded = error instanceof SeedBankError ? error.result.loaded : 0;
      const partial = loaded > 0 ? ` (успело добавиться ${loaded} задани(й))` : '';
      process.stderr.write(`посевной банк не загружен${partial}: ${(error as Error).message}\n`);
    }
  }

  function tryOpenSession(): SessionDatabase | undefined {
    try {
      const opened = openSessionDatabase(databasePath());
      if (opened === undefined) {
        process.stderr.write('занятие не поднято: файл базы сменился при открытии\n');
      }
      return opened;
    } catch (error) {
      process.stderr.write(`занятие не поднято: база недоступна: ${(error as Error).message}\n`);
      return undefined;
    }
  }

  if (trySyncCurriculum()) trySeedBank();

  // Занятию нужно живое соединение: выдача задания, приём ответа и разбор спора
  // идут транзакциями, а открывать базу на каждый запрос значит терять WAL и
  // получать чужой снимок посреди read-modify-write.
  // Вместе с соединением снимается отпечаток файла, с которым оно открыто:
  // health сверяет с ним то, что лежит по пути базы сейчас (см. `fileIdentity`).
  const opened = graph !== undefined && curriculumSynchronized ? tryOpenSession() : undefined;
  const session: DatabaseStatus = graph !== undefined && opened !== undefined ? 'ok' : 'error';
  if (graph !== undefined && opened !== undefined) {
    const sessionDb = opened.db;
    const budget = options.codexBudget ?? codexConcurrency;
    const disputes = options.disputeBudget ?? disputeConcurrency;
    let worker: WorkerHandle | undefined;
    const sessionAvailable = (): boolean => fileIdentity(databasePath()) === opened.file;
    const waitForReviews = registerSessionRoutes(app, {
      ...options,
      db: sessionDb,
      graph,
      available: sessionAvailable,
      disputeBudget: disputes,
    });
    registerRunRoutes(app, {
      db: sessionDb,
      graph,
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerTriageRoutes(app, {
      db: sessionDb,
      graph,
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerProfileRoutes(app, {
      db: sessionDb,
      available: sessionAvailable,
      ...(options.personaPath === undefined ? {} : { personaPath: options.personaPath }),
    });
    registerBossRoutes(app, {
      db: sessionDb,
      graph,
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerParentsRoutes(app, {
      db: sessionDb,
      graph,
      ...(parentPin === undefined ? {} : { parentPin }),
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerLearningRoutes(app, {
      db: sessionDb,
      graph,
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerGateRoutes(app, {
      db: sessionDb,
      available: sessionAvailable,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    app.addHook('onListen', async () => {
      if (options.worker === false || worker !== undefined) return;
      worker = startWorker({
        db: sessionDb,
        graph,
        budget,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.worker ?? {}),
      });
    });
    app.addHook('onClose', async () => {
      worker?.stop();
      await Promise.allSettled([
        ...(worker === undefined ? [] : [worker.done]),
        waitForReviews(),
      ]);
      sessionDb.close();
    });
  } else {
    registerUnavailableSession(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableRun(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableTriage(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableProfile(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableBoss(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableParents(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableLearning(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
    registerUnavailableGate(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
  }

  // `status` выводится из проверки базы, а не из факта «маршрут ответил»:
  // здоровье читают ровно тогда, когда что-то сломалось, и зелёный статус над
  // «database: error» ввёл бы в заблуждение именно в этот момент.
  //
  // Занятие входит в статус наравне с базой. Маршруты выбираются один раз при
  // старте, и поднявшаяся позже база их уже не вернёт: без этого поля health
  // отвечал бы `ok` процессу, который на все `/api/session/*` до перезапуска
  // отдаёт 503, — то есть врал бы именно о том, ради чего приложение и запущено.
  app.get('/api/health', (_request, reply) => {
    let database = checkDatabase();
    if (graph !== undefined) {
      // Исправную базу синхронизируем всегда: файл могли заменить под живым
      // процессом. Но исчезнувшую после успешного старта базу не создаём заново
      // — потеря прогресса должна остаться красным health. Повторная попытка
      // создать базу нужна только для восстановления после ошибки старта.
      const synchronized = database === 'ok' || !curriculumSynchronized
        ? trySyncCurriculum()
        : false;
      // Повторная проверка нужна только там, где база была недоступна и её мог
      // создать сам `trySyncCurriculum`: гонять `quick_check` второй раз по уже
      // признанной исправной базе незачем.
      if (!synchronized) database = 'error';
      else if (database !== 'ok') database = checkDatabase();
    }

    // Исправная база — ещё не работающее занятие: его соединение открыто один
    // раз при старте и держит тот файл, который лежал по пути тогда. Замена или
    // восстановление базы под живым процессом оставляет соединение на старом,
    // уже отвязанном файле, и под WAL это ничем не проявляется: пишется он без
    // ошибки, а данные остаются в файле, которого по пути базы нет, — то есть
    // ответы ученика уходят в никуда. Переоткрыть соединение здесь нельзя
    // (у занятия могут идти транзакции, а маршруты уже выбраны), поэтому health
    // краснеет до перезапуска — как и на не поднявшемся при старте занятии.
    const detached = opened !== undefined && fileIdentity(databasePath()) !== opened.file;
    const sessionNow: DatabaseStatus = session === 'ok' && !detached ? 'ok' : 'error';
    if (detached) {
      process.stderr.write(
        `файл базы заменён после старта: занятие держит прежний, нужен перезапуск\n`,
      );
    }

    const status: DatabaseStatus =
      database === 'ok' && curriculum === 'ok' && sessionNow === 'ok' ? 'ok' : 'error';

    return reply
      .code(status === 'ok' ? 200 : 503)
      .send({
        status,
        version: readVersion(),
        database,
        curriculum,
        session: sessionNow,
      });
  });

  if (webDist !== false) {
    void app.register(fastifyStatic, {
      root: webDist,
    });
    app.get('/parents', (_request, reply) => reply.sendFile('index.html'));
  }

  return app;
}

/**
 * Останавливает сервер по сигналу. Без этого `onClose` не срабатывает никогда:
 * процесс снимают по Ctrl-C, соединение занятия остаётся открытым, и WAL
 * закрывается не переносом в основной файл, а восстановлением при следующем
 * запуске. `once`: второй тот же сигнал должен убивать процесс по-обычному,
 * иначе зависшее закрытие нечем прервать.
 *
 * `SIGHUP` в списке наравне с остальными: сервер запускают из терминала, и его
 * закрытие — такой же обычный конец работы, как Ctrl-C. Он же держит в правде
 * `DEATH_SIGNALS` из `run-child.ts`: там на каждом из этих сигналов потомок
 * снимается, а смерть родителя досылается руками ровно тогда, когда сигнал до
 * нас никто не слушал. Разъехавшись, списки давали бы `SIGHUP` посреди разбора
 * спора — с убийством процесса из-под незакрытой базы.
 */
export function closeOnSignals(
  app: FastifyInstance,
  signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'],
): void {
  for (const signal of signals) {
    process.once(signal, () => {
      void app.close();
    });
  }
}

/**
 * Порт из окружения. Проверяется, а не приводится через `Number`: `??` ловит
 * только незаданную переменную, и `PORT=` давало `0` — Fastify слушал случайный
 * порт, а в баннере стояло `:0`, то есть единственная строка, по которой на
 * планшете открывают приложение, вела в никуда. `PORT=abc` давало `NaN` и
 * необработанный отказ верхнеуровневого `await`.
 */
export function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT должен быть целым числом от 1 до 65535, получено «${value}»`);
  }
  return port;
}

/** Адрес прослушивания из окружения; пустое значение не отменяет умолчание. */
export function readHost(value: string | undefined): string {
  const host = value?.trim();
  return host === undefined || host === '' ? HOST : host;
}

const isDirectRun = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  // Порт разбирается до `buildServer()`: `PORT=abc` — такая же обычная ошибка
  // запуска, как занятый порт, но брошенная после сборки сервера она уносила бы
  // процесс необработанным исключением мимо `app.close()`, то есть из-под уже
  // открытого соединения занятия и с непереселённым WAL.
  let port: number | undefined;
  try {
    port = readPort(process.env.PORT);
  } catch (error) {
    process.stderr.write(`edukator не поднялся: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }

  if (port !== undefined) {
    const host = readHost(process.env.HOST);
    const app = buildServer();
    closeOnSignals(app);
    // Отказ прослушивания перехватывается, как и в обеих точках входа CLI: занятое
    // порт-число — обычная ошибка запуска, а необработанный отказ верхнеуровневого
    // `await` печатал бы стек `node:net` и уносил процесс мимо `app.close()`, то
    // есть оставлял бы соединение занятия незакрытым, а WAL — непереселённым.
    try {
      await app.listen({ host, port });
      console.log(`edukator слушает http://${host}:${port}`);
    } catch (error) {
      process.stderr.write(`edukator не поднялся на порту ${port}: ${(error as Error).message}\n`);
      await app.close();
      process.exitCode = 1;
    }
  }
}
