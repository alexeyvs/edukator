import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { CURRICULUM_DIR, loadCurriculum, type TopicGraph } from './curriculum.js';
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
import { registerAuthRoutes, registerUnavailableAuth } from './routes/auth.js';
import {
  registerAdminAuthRoutes,
  registerUnavailableAdminAuth,
} from './routes/admin/auth.js';
import {
  registerAdminOverviewRoutes,
  registerUnavailableAdminOverview,
} from './routes/admin/overview.js';
import {
  registerAdminStatsRoutes,
  registerUnavailableAdminStats,
} from './routes/admin/stats.js';
import {
  registerAdminChildrenRoutes,
  registerUnavailableAdminChildren,
} from './routes/admin/children.js';
import {
  registerAdminLogsRoutes,
  registerUnavailableAdminLogs,
} from './routes/admin/logs.js';
import {
  registerAdminImpersonateRoutes,
  registerUnavailableAdminImpersonate,
} from './routes/admin/impersonate.js';
import {
  registerAdminAuditRoutes,
  registerUnavailableAdminAudit,
} from './routes/admin/audit.js';
import { registerFamilyRoutes, registerUnavailableFamily } from './routes/family.js';
import { codexConcurrency, disputeConcurrency, type CodexConcurrency } from './codex/concurrency.js';
import { createQuotedRunner } from './codex/quota.js';
import { WarmupDispatcher, type DispatcherWorkerOptions } from './codex/dispatcher.js';
import { readPinPepper } from './parent-pin.js';
import { controlDatabasePath, dataDir as defaultDataDir, ensureDataDir } from './data-dir.js';
import {
  acquireDataLock,
  DataLockBusyError,
  SERVER_LOCK_OWNER,
  type DataLock,
} from './data-lock.js';
import { openControlDatabase, validateControlSchema } from './control-db.js';
import { fileIdentity, TenantRegistry } from './tenant-registry.js';
import type { DisputeCoordinatorOptions } from './dispute-coordinator.js';
import type { IntegrityCoordinatorOptions } from './integrity.js';
import { createAdminContext, createTenantContext } from './routes/tenant-context.js';
import { redactTokenUrl, registerTokenPrivacy } from './routes/token-privacy.js';
import { failureLogFor, type FailureLog } from './log.js';
import { AdminStatsCache } from './admin/stats.js';
import { ImpersonationTenants } from './admin/impersonation-tenants.js';
import { ImpersonationRefusals } from './admin/impersonation-refusals.js';
import { createTenantOpener } from './tenant-opener.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
export const WEB_DIST_DIR = resolve(projectRoot, 'web', 'dist');

/**
 * Версия приложения из package.json — отдаётся в /api/health. Нечитаемый или
 * битый файл роняет не запрос, а только само поле: маршрут здоровья читают,
 * чтобы узнать причину поломки, и 500 вместо «control: error» её как раз прячет.
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

/** Адрес по умолчанию; скрипт рабочего запуска переопределяет его через `HOST`. */
export const HOST = '0.0.0.0';

/** Порт по умолчанию; переопределяется переменной `PORT` (см. `readPort`). */
export const DEFAULT_PORT = 3000;

export type CurriculumStatus = 'ok' | 'error';

/**
 * Адреса, по которым браузеру отдаётся сама страница приложения.
 *
 * Список объявлен одним местом нарочно: маршрутов у клиента больше, чем у
 * сервера, и забытый здесь адрес виден не как ошибка сборки, а как мёртвая
 * ссылка у ребёнка — тот перешёл по приглашению и получил 404 от Fastify.
 * `/join/:token` и `/invite/:token` называются шаблоном, потому что токен в
 * них — часть пути, а не запрос (см. `server/routes/token-privacy.ts`).
 */
export const APP_PAGES = [
  '/',
  '/parents',
  '/admin',
  '/admin/child/:childId',
  '/join/:token',
  '/invite/:token',
] as const;

/** Настройки сервера, которые подменяют тесты и рабочий запуск. */
export type ServerOptions =
  & Omit<SessionRoutesOptions, 'context' | 'graph'>
  & Omit<DisputeCoordinatorOptions, 'db' | 'graph' | 'available' | 'log'>
  & {
  /**
   * Каталог данных: `control.db` рядом с `children/<id>.db`. Обязателен и
   * передаётся явно: единой точки вроде прежнего `EDUKATOR_DB` у многоарендного
   * сервера нет, каталог выбирает вызывающий.
   */
  dataDir: string;
  /** Подменяется только в тестах ошибочной конфигурации. */
  personaPath?: string;
  /** Подмена настроек воркера в тестах; false отключает его для служебного сервера. */
  worker?: false | DispatcherWorkerOptions;
  /** Подменяемый бюджет фонового воркера. */
  codexBudget?: CodexConcurrency;
  /** Подменяемая проверка осмысленности; по умолчанию — отдельный вызов codex. */
  integrityReview?: IntegrityCoordinatorOptions['review'];
  /** Подменяемый общий бюджет проверки осмысленности. */
  integrityBudget?: IntegrityCoordinatorOptions['budget'];
  /** Первая пауза фонового повтора проверки осмысленности. */
  integrityRetryMs?: number;
  /** false оставляет статику Vite dev-серверу; строка подменяет каталог в тестах. */
  webDist?: string | false;
  /** Потолок одновременно открытых детских баз; по умолчанию — потолок реестра. */
  maxOpenTenants?: number;
  /** Серверный pepper PIN; по умолчанию из `EDUKATOR_PIN_PEPPER`. */
  pinPepper?: string;
  /** Кому верить в `X-Forwarded-For`; по умолчанию из окружения. */
  trustedProxies?: Set<string>;
  /** Снять `Secure` с cookie. Только для разработки по голому http. */
  insecureCookies?: boolean;
  /** Журнал аварий; по умолчанию — файл в каталоге данных. */
  failures?: FailureLog;
};

/**
 * Общий обработчик отказов.
 *
 * Fastify по умолчанию отдаёт текст исключения в теле ответа, а внутренние
 * ошибки называют абсолютные пути и содержимое базы. Сервер слушает всю
 * домашнюю сеть, так что наружу уходит только факт поломки, а подробности — в
 * stderr. Отказы самого Fastify (битый JSON в теле — 400) остаются как есть:
 * они про запрос, а не про внутренности.
 *
 * Адрес перед записью проходит `redactTokenUrl`: приглашение и детская ссылка
 * живут прямо в пути, а stderr сервера читают и хранят как обычный лог, — то
 * есть полный `request.url` означал бы вход в чужую учётную запись, лежащий в
 * файле. Отдельной функцией это вынесено потому, что проверить запись можно
 * только на маршруте, который бросает, а таких в самом сервере нет.
 *
 * Пишется и в stderr, и в журнал: журнал лежит в каталоге данных, а процесс,
 * упавший до того, как каталог известен, виден только в stderr. Журнал
 * передаётся обязательным аргументом — умолчание писало бы в каталог по
 * умолчанию из любого теста, поднявшего свой Fastify.
 */
export function registerErrorHandler(app: FastifyInstance, failures: FailureLog): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.message });

    const route = redactTokenUrl(request.url);
    process.stderr.write(`${request.method} ${route}: ${error.message}\n`);
    failures({
      event: 'server-error',
      message: `${request.method} ${route}: ${error.message}`,
      route: request.url,
      status,
    });
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });
}

/**
 * Собирает сервер.
 *
 * Отказы точечные: карта тем и управляющая база гасят всё разом — без них не
 * разобрать ни одного предъявителя, — а испорченная база одного ребёнка
 * краснит только его запросы. Соединения занятия в замыкании больше нет:
 * маршруты регистрируются один раз, а базу выбирает предъявитель (см.
 * `server/routes/tenant-context.ts`).
 */
export function buildServer(
  curriculumDir: string = CURRICULUM_DIR,
  options: ServerOptions,
): FastifyInstance {
  const dataDir = options.dataDir;
  const controlPath = controlDatabasePath(dataDir);
  const log = options.log ?? ((message: string): void => {
    process.stderr.write(`${message}\n`);
  });
  // Журнал заводится до первой возможной аварии: каталог данных известен уже
  // здесь, а незаписываемый каталог журнал переживает сам — запись отказывает в
  // stderr и на этом заканчивается.
  const failures = options.failures ?? failureLogFor(dataDir);
  const pinPepper = readPinPepper(options.pinPepper ?? process.env['EDUKATOR_PIN_PEPPER']);
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

  // Замок берётся до первой базы и до единой строки маршрутов: чужой живой
  // процесс на том же каталоге — это вторая пара слотов codex и второй прогрев,
  // то есть ровно тот сценарий, ради которого прогрев сведён в один диспетчер.
  // Занятость — обычная ошибка запуска вроде занятого порта и гасит сборку.
  //
  // Незаписываемый каталог — другое дело: он и есть та поломка, ради которой
  // читают /api/health, и уронить сервер здесь значило бы отнять единственный
  // способ узнать причину. Замка в этом случае просто нет — как нет и
  // управляющей базы, без которой ни один запрос всё равно не проходит.
  let lock: DataLock | undefined;
  try {
    lock = acquireDataLock(dataDir, SERVER_LOCK_OWNER);
  } catch (error) {
    if (error instanceof DataLockBusyError) throw error;
    log(`замок каталога данных не взят: ${(error as Error).message}`);
    failures({
      event: 'startup-failed',
      message: 'замок каталога данных не взят',
      detail: (error as Error).message,
    });
  }

  // Управляющая база объявляется снаружи сборки: если та сорвётся после
  // взятия замка, закрыть соединение и снять замок обязан этот же вызов —
  // `onClose` живёт на приложении, которого при отказе никто не получит.
  let control: Database.Database | undefined;

  try {
    const app = Fastify({ logger: false });

    // Снятие замка регистрируется **первым**: `onClose` в Fastify выполняются в
    // обратном порядке регистрации, так что первый зарегистрированный отработает
    // последним — уже после закрытия арендаторов и управляющей базы. Обратный
    // порядок освободил бы каталог, пока уходящий сервер ещё держит открытые базы
    // и идущие вызовы codex, и `prefetch` завёл бы вторую пару слотов поверх
    // недописанного WAL.
    app.addHook('onClose', async () => {
      lock?.release();
    });

    registerErrorHandler(app, failures);
    registerTokenPrivacy(app);

    let curriculum: CurriculumStatus = 'ok';
    let graph: TopicGraph | undefined;

    // Непрочитанная карта тем не должна мешать серверу подняться: иначе
    // /api/health — единственное, что умеет назвать причину поломки — становится
    // недоступен ровно в тот раз, когда он и нужен.
    try {
      graph = loadCurriculum(curriculumDir);
    } catch (error) {
      curriculum = 'error';
      log(`карта тем не загружена: ${(error as Error).message}`);
      failures({
        event: 'startup-failed',
        message: 'карта тем не загружена',
        detail: (error as Error).message,
      });
    }

    /**
     * Открывает управляющую базу. Каталог данных заводится здесь же: без него не
     * открыть ни `control.db`, ни базу первого же ребёнка, а отдельный `mkdir` у
     * каждого вызывающего рано или поздно забыли бы.
     */
    function tryOpenControl(): Database.Database | undefined {
      try {
        ensureDataDir(dataDir);
        return openControlDatabase(controlPath);
      } catch (error) {
        log(`управляющая база недоступна: ${(error as Error).message}`);
        failures({
          event: 'control-error',
          message: 'управляющая база не открыта',
          detail: (error as Error).message,
        });
        return undefined;
      }
    }

    control = tryOpenControl();
    // Отпечаток снимается один раз, после открытия: `openControlDatabase` заводит
    // файл, если его нет, так что замер «до» здесь ничего не значил бы. Сверять с
    // ним health обязан по той же причине, что и по детским базам: под WAL запись
    // в подменённый файл проходит молча (см. `fileIdentity`).
    const controlFile = control === undefined ? undefined : fileIdentity(controlPath);

    let registry: TenantRegistry | undefined;

    if (graph !== undefined && control !== undefined) {
      const loaded = graph;
      // Отдельная привязка, а не сам `control`: сужение типа не доживает до тела
      // вложенной функции, а квота списывается именно оттуда.
      const controlDb = control;
      const budget = options.codexBudget ?? codexConcurrency;
      const tenants = new TenantRegistry({
        control,
        dataDir,
        graph: loaded,
        log,
        failures,
        ...(options.maxOpenTenants === undefined ? {} : { maxOpen: options.maxOpenTenants }),
        ...(options.seedDir === undefined ? {} : { seedDir: options.seedDir }),
        ...(options.review === undefined ? {} : { review: options.review }),
        ...(options.background === undefined ? {} : { background: options.background }),
        disputeBudget: options.disputeBudget ?? disputeConcurrency,
        ...(options.disputeRetryMs === undefined ? {} : { disputeRetryMs: options.disputeRetryMs }),
        ...(options.integrityReview === undefined ? {} : { integrityReview: options.integrityReview }),
        integrityBudget: options.integrityBudget ?? options.codexBudget ?? codexConcurrency,
        ...(options.integrityRetryMs === undefined ? {} : { integrityRetryMs: options.integrityRetryMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registry = tenants;

      // Отдельная привязка: сужение `options.worker` до настроек не доживает до
      // тела вложенной функции, а обёртка квоты берёт `run` именно оттуда.
      const workerSettings = options.worker === false ? undefined : options.worker ?? {};

      // Прогрев на весь процесс один, а не на каждую открытую базу: бюджет codex
      // процессный, и свой цикл у каждого ребёнка означал бы гонку за два слота, в
      // которой занимающийся ученик стоит наравне с тем, кто ушёл спать. Порядок
      // и фазы обхода — в `WarmupDispatcher`.
      const dispatcher =
        workerSettings === undefined
          ? undefined
          : new WarmupDispatcher({
              control,
              graph: loaded,
              log,
              failures,
              budget,
              // Отказ базы одного ребёнка обход не останавливает: причину уже
              // назвал реестр, диспетчер просто идёт к следующему.
              open: (childId: string) => {
                try {
                  const tenant = tenants.open(childId);
                  // Отпечаток сверяется и здесь. Кешированная аренда его не
                  // перепроверяет, а маршруты и разбор споров — да: по
                  // подменённому файлу они отвечают 503 и ничего не пишут.
                  // Обход, оставленный без сверки, тратил бы на такого ребёнка
                  // суточную квоту целиком и складывал бы задания в отвязанный
                  // inode — при этом `stored > 0`, то есть обход выглядел бы
                  // здоровым до самого перезапуска.
                  return tenant.available() ? tenant.db : undefined;
                } catch {
                  return undefined;
                }
              },
              // Квота надевается на сам вызов модели, а не на бюджет: за одним
              // слотом семафора прячется от двух вызовов (батч — генератор и
              // проверяющий) до шести (персональный материал), и счёт по слотам
              // превратил бы предел в кратный ему. Подменённый в тестах `run`
              // обёртка оборачивает, а не теряет.
              runFor: (childId: string) =>
                createQuotedRunner({
                  control: controlDb,
                  childId,
                  ...(workerSettings.run === undefined ? {} : { run: workerSettings.run }),
                  ...(options.now === undefined ? {} : { now: options.now }),
                }),
              worker: workerSettings,
              ...(options.now === undefined ? {} : { now: options.now }),
            });

      // Соединения только для чтения, которыми смотрят чужие семьи. Живут рядом
      // с реестром, а не внутри него: реестр держит по одной базе на ребёнка, а
      // второй handle — свойство захода оператора, а не аренды.
      const impersonations = new ImpersonationTenants({
        graph: loaded,
        log,
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      const opener = createTenantOpener({
        tenants,
        impersonations,
        ...(dispatcher === undefined ? {} : { wake: (childId: string) => dispatcher.wake(childId) }),
      });

      // Отказы первого замка считает тот, кто пишет запись о конце захода:
      // счётчик обязан пережить запрос, а `resolveTenant` между запросами не
      // помнит ничего.
      const refusals = new ImpersonationRefusals();

      // Один выключатель на cookie и на проверку источника: и `Secure`, и
      // требование `https://` у `Origin` снимаются только ради локальной
      // разработки по голому http, и разъехавшись они дали бы сервер, который
      // ставит незащищённые cookie, но отвергает собственную страницу.
      const insecureCookies =
        options.insecureCookies ?? process.env['EDUKATOR_INSECURE_COOKIES'] === '1';

      const context = createTenantContext({
        control,
        tenants: opener,
        insecureCookies,
        onReadOnly: (impersonation) => refusals.record(impersonation.adminId),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      registerAuthRoutes(app, {
        control,
        failures,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
        insecureCookies,
      });
      registerAdminAuthRoutes(app, {
        control,
        failures,
        // Выход из админки закрывает и живой заход: счётчик отказов и
        // соединения имперсонации нужны ему по той же причине, что и явному
        // выходу из семьи.
        refusals,
        impersonations,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
        insecureCookies,
      });
      // Админка разрешается своим резолвером и реестра не получает: её первый
      // экран обязан открываться и тогда, когда с детскими базами беда.
      const adminContext = createAdminContext({
        control,
        insecureCookies,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerAdminOverviewRoutes(app, {
        context: adminContext,
        control,
        dataDir,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      // Кеш отчёта один на процесс и живёт рядом с маршрутом, а не внутри
      // него: посчитанный обход всех детских баз обязан пережить запрос, иначе
      // открытый на стене экран читал бы их при каждом обновлении страницы.
      registerAdminStatsRoutes(app, {
        context: adminContext,
        cache: new AdminStatsCache({
          control,
          dataDir,
          graph: loaded,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      });
      registerAdminChildrenRoutes(app, {
        context: adminContext,
        control,
        dataDir,
        graph: loaded,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerAdminLogsRoutes(app, { context: adminContext, dataDir });
      registerAdminImpersonateRoutes(app, {
        context: adminContext,
        control,
        refusals,
        impersonations,
        ...(options.now === undefined ? {} : { now: options.now }),
        insecureCookies,
      });
      registerAdminAuditRoutes(app, { context: adminContext, control });
      registerFamilyRoutes(app, {
        control,
        dataDir,
        // Аренды у этих маршрутов нет, а замок имперсонации нужен: состав
        // семьи лежит в управляющей базе, до которой `query_only` не достаёт.
        onReadOnly: (impersonation) => refusals.record(impersonation.adminId),
        insecureCookies,
        ...(pinPepper === undefined ? {} : { pinPepper }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerSessionRoutes(app, {
        context,
        graph: loaded,
        log,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.seedDir === undefined ? {} : { seedDir: options.seedDir }),
      });
      registerRunRoutes(app, {
        context,
        graph: loaded,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerTriageRoutes(app, {
        context,
        graph: loaded,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerIntegrityRoutes(app, { context });
      registerProfileRoutes(app, {
        context,
        ...(options.personaPath === undefined ? {} : { personaPath: options.personaPath }),
      });
      registerBossRoutes(app, {
        context,
        graph: loaded,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerParentsRoutes(app, {
        context,
        graph: loaded,
        control,
        failures,
        ...(pinPepper === undefined ? {} : { pinPepper }),
        ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerLearningRoutes(app, {
        context,
        graph: loaded,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      registerGateRoutes(app, {
        context,
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      // Прогрев начинается с прослушиванием, а не со сборки: греть банк раньше,
      // чем сервер вообще способен ответить ученику, незачем, а тесты маршрутов
      // ходят через `inject` и фоновой генерации не поднимают вовсе.
      app.addHook('onListen', async () => {
        dispatcher?.start();
      });
      app.addHook('onClose', async () => {
        await dispatcher?.stop();
        // Соединения имперсонации первыми: они ничего не пишут и никого не
        // ждут, а держат дескриптор той же базы, которую сейчас закроет реестр.
        impersonations.closeAll();
        // Порядок задан зависимостями, а не удобством. Диспетчер первым: его
        // заход держит и базу ребёнка, и счётчик квоты в `control.db`. Потом
        // арендаторы: закрытие аренды дожидается её разбора спора, а тот после
        // ответа модели пишет вердикт в базу ребёнка. Управляющая база последней —
        // на ней стоит разбор предъявителя у всего, что ещё могло не доехать.
        await tenants.closeAll();
        controlDb.close();
      });
    } else {
      const reason = graph === undefined ? 'карта тем не загружена' : 'управляющая база недоступна';
      registerUnavailableAuth(app, reason);
      registerUnavailableAdminAuth(app, reason);
      registerUnavailableAdminOverview(app, reason);
      registerUnavailableAdminStats(app, reason);
      registerUnavailableAdminChildren(app, reason);
      registerUnavailableAdminLogs(app, reason);
      registerUnavailableAdminImpersonate(app, reason);
      registerUnavailableAdminAudit(app, reason);
      registerUnavailableFamily(app, reason);
      registerUnavailableSession(app, reason);
      registerUnavailableRun(app, reason);
      registerUnavailableTriage(app, reason);
      registerUnavailableIntegrity(app, reason);
      registerUnavailableProfile(app, reason);
      registerUnavailableBoss(app, reason);
      registerUnavailableParents(app, reason);
      registerUnavailableLearning(app, reason);
      registerUnavailableGate(app, reason);
      // Отдельная привязка по той же причине, что и у `controlDb` выше: сужение
      // типа не доживает до тела хука.
      const opened = control;
      if (opened !== undefined) {
        app.addHook('onClose', async () => {
          opened.close();
        });
      }
    }

    /**
     * Что уже записано в журнал этим маршрутом. Здоровье опрашивает монитор,
     * и запись на каждый опрос — это не диагностика, а её уничтожение: и
     * поломка управляющей базы, и отвязанный файл ребёнка держатся до
     * перезапуска, так что за час опроса раз в минуту журнал вытеснил бы
     * ровно ту запись, которая называет причину. Пишется поэтому переход
     * состояния, а не факт опроса; маршрут не авторизован, и записывать по
     * запросу извне мы себе позволить не можем вовсе.
     */
    let loggedControlError = false;
    const loggedDetached = new Set<string>();

    /**
     * Состояние управляющей базы. Проверяется подробно: без неё сервер не умеет
     * разобрать ни одного предъявителя, то есть не работает вовсе, — и цена
     * `quick_check` по одному маленькому файлу здесь оправдана.
     */
    function checkControl(): DatabaseStatus {
      if (control === undefined || controlFile === undefined) return 'error';
      try {
        if (fileIdentity(controlPath) !== controlFile) {
          throw new Error('файл заменён после старта, нужен перезапуск');
        }
        validateControlSchema(control);
        loggedControlError = false;
        return 'ok';
      } catch (error) {
        log(`управляющая база ${controlPath} недоступна: ${(error as Error).message}`);
        if (!loggedControlError) {
          loggedControlError = true;
          failures({
            event: 'control-error',
            message: 'управляющая база недоступна',
            detail: (error as Error).message,
          });
        }
        return 'error';
      }
    }

    // `status` выводится из проверки, а не из факта «маршрут ответил»: здоровье
    // читают ровно тогда, когда что-то сломалось, и зелёный статус над
    // «control: error» ввёл бы в заблуждение именно в этот момент.
    //
    // Детские базы обходятся **только открытые**. Открыть базу каждого ребёнка
    // ради `quick_check` значило бы, что опрос здоровья заводит соединения,
    // которых никто не просил, и платит за всех выведенных детей сразу; а
    // ребёнок, к которому не обращались, сломаться с прошлого раза не мог.
    app.get('/api/health', (_request, reply) => {
      const control = checkControl();
      const open = registry?.list() ?? [];
      // Подмена файла базы под живым процессом ничем не проявляется сама: под WAL
      // запись в отвязанный файл проходит без ошибки, а данные остаются там, где
      // их уже никто не найдёт. Переоткрыть соединение здесь нельзя — у занятия
      // могут идти транзакции, — поэтому ребёнок краснеет до перезапуска.
      const detached = open.filter((tenant) => !tenant.available()).map((tenant) => tenant.childId);
      if (detached.length > 0) {
        log(`файл базы заменён после старта у детей: ${detached.join(', ')}; нужен перезапуск`);
        // Запись на ребёнка, а не одна на всех: фильтр админки ищет по
        // `childId`, и список в тексте сообщения ему не виден. По одной на
        // ребёнка за весь запуск: отвязанный файл держится до перезапуска, и
        // повтор на каждый опрос здоровья вытеснил бы из журнала всё
        // остальное.
        for (const childId of detached) {
          if (loggedDetached.has(childId)) continue;
          loggedDetached.add(childId);
          failures({
            event: 'tenant-detached',
            message: 'файл базы заменён после старта, нужен перезапуск',
            childId,
          });
        }
      }

      const status: DatabaseStatus =
        control === 'ok' && curriculum === 'ok' && detached.length === 0 ? 'ok' : 'error';

      return reply
        .code(status === 'ok' ? 200 : 503)
        .send({
          status,
          version: readVersion(),
          control,
          curriculum,
          children: { open: open.length, detached },
        });
    });

    if (webDist !== false) {
      void app.register(fastifyStatic, {
        root: webDist,
      });
      // Страница у приложения одна: маршрутизацию внутри неё делает клиент, и
      // серверу остаётся отдать по каждому её адресу тот же `index.html`.
      for (const page of APP_PAGES) {
        app.get(page, (_request, reply) => reply.sendFile('index.html'));
      }
    }

    return app;
  } catch (error) {
    // Сборка сорвалась уже после взятия замка: без уборки замок остался бы
    // на диске с живым pid, а управляющая база — открытой. Внутри одного
    // процесса это ещё и счётчик `heldLocks`, из-за которого следующая
    // сборка на том же каталоге считала бы замок своим.
    control?.close();
    lock?.release();
    throw error;
  }
}

/**
 * Останавливает сервер по сигналу. Без этого `onClose` не срабатывает никогда:
 * процесс снимают по Ctrl-C, соединения занятия остаются открытыми, и WAL
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
  // открытых баз и с непереселённым WAL.
  let port: number | undefined;
  try {
    port = readPort(process.env.PORT);
  } catch (error) {
    process.stderr.write(`edukator не поднялся: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }

  // Сборка тоже перехватывается: занятый другим сервером каталог данных и
  // несобранный интерфейс — обычные ошибки запуска, и стек в терминале вместо
  // одной строки прячет от запустившего именно причину.
  let app: FastifyInstance | undefined;
  if (port !== undefined) {
    try {
      app = buildServer(CURRICULUM_DIR, { dataDir: defaultDataDir() });
    } catch (error) {
      process.stderr.write(`edukator не поднялся: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }

  if (port !== undefined && app !== undefined) {
    const host = readHost(process.env.HOST);
    const listening = app;
    closeOnSignals(listening);
    // Отказ прослушивания перехватывается, как и в обеих точках входа CLI: занятое
    // порт-число — обычная ошибка запуска, а необработанный отказ верхнеуровневого
    // `await` печатал бы стек `node:net` и уносил процесс мимо `app.close()`, то
    // есть оставлял бы базы незакрытыми, а WAL — непереселённым.
    try {
      await listening.listen({ host, port });
      console.log(`edukator слушает http://${host}:${port}`);
    } catch (error) {
      process.stderr.write(`edukator не поднялся на порту ${port}: ${(error as Error).message}\n`);
      await listening.close();
      process.exitCode = 1;
    }
  }
}
