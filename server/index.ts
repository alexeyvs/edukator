import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDatabase } from './db.js';
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
import { registerIntegrityRoutes, registerUnavailableIntegrity } from './routes/integrity.js';
import { codexConcurrency, disputeConcurrency, type CodexConcurrency } from './codex/concurrency.js';
import { startWorker, type StartWorkerOptions, type WorkerHandle } from './codex/worker.js';
import { hashParentPin, readParentPin, readPinPepper } from './parent-pin.js';
import { ensureDataDir, legacySessionDatabasePath } from './data-dir.js';
import {
  fileIdentity,
  openSessionDatabase,
  type SessionDatabase,
} from './tenant-registry.js';
import {
  DisputeCoordinator,
  type DisputeCoordinatorOptions,
} from './dispute-coordinator.js';
import {
  SINGLE_TENANT_CHILD_ID,
  singleTenantContext,
} from './routes/tenant-context.js';
import { redactTokenUrl, registerTokenPrivacy } from './routes/token-privacy.js';
import type { Tenant } from './tenant-registry.js';
import { createIntegrityCoordinator } from './integrity.js';
import type { IntegrityReviewer } from './codex/integrity.js';
import { finishRun } from './run.js';
import { finishLearningMaterial } from './learning.js';
import { readDailyGate } from './daily-gate.js';

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
export function checkDatabase(path: string): DatabaseStatus {
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
 * Заводит в `topic_state` темы, которых там ещё нет (спека: «при старте сервера
 * отсутствующие темы заводятся с нулевыми значениями»). Без этого планировщик
 * считает недостающую строку нулевым состоянием и спокойно ставит тему в план,
 * а `recordAttempt` на первом же ответе по ней падает.
 */
export function syncCurriculumState(
  path: string,
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
export type ServerOptions =
  & Omit<SessionRoutesOptions, 'context' | 'graph'>
  & Omit<DisputeCoordinatorOptions, 'db' | 'graph' | 'available' | 'log'>
  & {
  /**
   * База занятия. Обязательна и передаётся явно: единой точки вроде прежнего
   * `EDUKATOR_DB` у многоарендного сервера нет, путь выбирает вызывающий.
   */
  dbPath: string;
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
  /** Подменяемая проверка осмысленности; по умолчанию — отдельный вызов codex. */
  integrityReview?: IntegrityReviewer;
  /** Первая пауза фонового повтора проверки. */
  integrityRetryMs?: number;
};

/**
 * Общий обработчик отказов.
 *
 * Fastify по умолчанию отдаёт текст исключения в теле ответа, а внутренние
 * ошибки называют абсолютные пути и содержимое базы. Сервер слушает всю
 * домашнюю сеть без пароля, так что наружу уходит только факт поломки, а
 * подробности — в stderr. Отказы самого Fastify (битый JSON в теле — 400)
 * остаются как есть: они про запрос, а не про внутренности.
 *
 * Адрес перед записью проходит `redactTokenUrl`: приглашение и детская ссылка
 * живут прямо в пути, а stderr сервера читают и хранят как обычный лог, — то
 * есть полный `request.url` означал бы вход в чужую учётную запись, лежащий в
 * файле. Отдельной функцией это вынесено потому, что проверить запись можно
 * только на маршруте, который бросает, а таких в самом сервере нет.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.message });

    process.stderr.write(
      `${request.method} ${redactTokenUrl(request.url)}: ${error.message}\n`,
    );
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });
}

export function buildServer(
  curriculumDir: string = CURRICULUM_DIR,
  options: ServerOptions,
): FastifyInstance {
  const dbPath = options.dbPath;
  const parentPin = readParentPin(options.parentPin ?? process.env.EDUKATOR_PARENT_PIN);
  const pinPepper = readPinPepper(process.env.EDUKATOR_PIN_PEPPER);
  // Эталон живёт хешем: открытого PIN не остаётся ни в замыкании маршрута, ни в
  // снимке кучи. Без pepper проверка отказала бы всегда, поэтому PIN считается
  // ненастроенным — так маршрут отвечает 503, а не молчаливым «неверный PIN».
  const parentPinHash = parentPin === undefined || pinPepper === undefined
    ? undefined
    : hashParentPin(parentPin, pinPepper);
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

  registerErrorHandler(app);
  registerTokenPrivacy(app);

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
      syncLoadedCurriculum(dbPath, graph);
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
      const seeded = loadSeedTasks(dbPath, graph, options.seedDir);
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
      const opened = openSessionDatabase(dbPath);
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
    const sessionAvailable = (): boolean => fileIdentity(dbPath) === opened.file;
    // Состояние разбора спора своё на каждую базу, а не на процесс: до задачи 15
    // база здесь одна, но координатор уже тот же, что заводит реестр детских баз.
    const disputeCoordinator = new DisputeCoordinator({
      db: sessionDb,
      graph,
      available: sessionAvailable,
      disputeBudget: disputes,
      ...(options.review === undefined ? {} : { review: options.review }),
      ...(options.background === undefined ? {} : { background: options.background }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.disputeRetryMs === undefined ? {} : { disputeRetryMs: options.disputeRetryMs }),
    });
    const integrity = createIntegrityCoordinator({
      db: sessionDb,
      graph,
      budget,
      available: sessionAvailable,
      complete: (runId, at) => {
        const kind = sessionDb.prepare<[number], { kind: string }>('SELECT kind FROM runs WHERE id = ?')
          .get(runId)?.kind;
        if (kind === 'lesson') {
          const result = finishLearningMaterial(sessionDb, graph, runId, { now: at });
          const learningGate = readDailyGate(sessionDb, at).learning;
          const completed = {
            ...result,
            required: learningGate.required && learningGate.materialId === result.materialId,
          };
          sessionDb.prepare('UPDATE runs SET summary = ? WHERE id = ?')
            .run(JSON.stringify(completed), runId);
          return completed;
        }
        if (kind === 'run') return { ...finishRun(sessionDb, graph, runId, { now: at }) };
        throw new Error(`Проверка осмысленности не завершает занятие вида «${String(kind)}»`);
      },
      ...(options.integrityReview === undefined ? {} : { review: options.integrityReview }),
      ...(options.background === undefined ? {} : { background: options.background }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.integrityRetryMs === undefined ? {} : { retryMs: options.integrityRetryMs }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    // Аренда собирается руками: до задачи 15 база здесь одна и реестра ещё нет,
    // но маршруты уже спрашивают её контекстом запроса, а не замыканием.
    const tenant: Tenant = {
      childId: SINGLE_TENANT_CHILD_ID,
      path: dbPath,
      db: sessionDb,
      file: opened.file,
      available: sessionAvailable,
      disputes: disputeCoordinator,
      integrity,
    };
    const context = singleTenantContext(tenant);
    registerSessionRoutes(app, {
      context,
      graph,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.seedDir === undefined ? {} : { seedDir: options.seedDir }),
    });
    // Спор переживает процесс в SQLite. После перезапуска его нельзя оставлять
    // без исполнителя только потому, что браузер уже потерял attempt_id.
    disputeCoordinator.restore();
    registerRunRoutes(app, {
      context,
      graph,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerTriageRoutes(app, {
      context,
      graph,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerIntegrityRoutes(app, { context });
    registerProfileRoutes(app, {
      context,
      ...(options.personaPath === undefined ? {} : { personaPath: options.personaPath }),
    });
    registerBossRoutes(app, {
      context,
      graph,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerParentsRoutes(app, {
      context,
      graph,
      ...(parentPinHash === undefined ? {} : { parentPinHash: () => parentPinHash }),
      ...(pinPepper === undefined ? {} : { pinPepper }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerLearningRoutes(app, {
      context,
      graph,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    registerGateRoutes(app, {
      context,
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
        disputeCoordinator.stop(),
        integrity.stop(),
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
    registerUnavailableIntegrity(
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
    let database = checkDatabase(dbPath);
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
      else if (database !== 'ok') database = checkDatabase(dbPath);
    }

    // Исправная база — ещё не работающее занятие: его соединение открыто один
    // раз при старте и держит тот файл, который лежал по пути тогда. Замена или
    // восстановление базы под живым процессом оставляет соединение на старом,
    // уже отвязанном файле, и под WAL это ничем не проявляется: пишется он без
    // ошибки, а данные остаются в файле, которого по пути базы нет, — то есть
    // ответы ученика уходят в никуда. Переоткрыть соединение здесь нельзя
    // (у занятия могут идти транзакции, а маршруты уже выбраны), поэтому health
    // краснеет до перезапуска — как и на не поднявшемся при старте занятии.
    const detached = opened !== undefined && fileIdentity(dbPath) !== opened.file;
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
    // Каталог данных заводится до сборки сервера: без него не открыть ни базу
    // занятия, ни, начиная со следующих задач, управляющую.
    const app = buildServer(CURRICULUM_DIR, { dbPath: legacySessionDatabasePath(ensureDataDir()) });
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
