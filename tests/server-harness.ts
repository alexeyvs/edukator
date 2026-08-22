/**
 * Многоарендный сервер для тестов маршрутов: родитель, ребёнок с готовой базой
 * и его устройство.
 *
 * Маршрутные тесты проверяют занятие, забег, босса и сводку, а не допуск —
 * его проверяют `tests/auth.test.ts` и `tests/tenant-context.test.ts`. Поэтому
 * cookie устройства и подтверждение источника подставляются один раз, подменой
 * самого `app.inject`: иначе двести с лишним вызовов в тестах отличались бы от
 * рабочего пути только шапкой из двух заголовков.
 *
 * Заголовки при этом настоящие: сервер разбирает ту же cookie тем же
 * `resolveBearer` и открывает ту же базу тем же реестром, что и в рабочем
 * запуске. Подменяется отправитель, а не проверка.
 */
import type { Database } from 'better-sqlite3';
import type { FailureRecord } from '../server/log.js';
import type { FastifyInstance } from 'fastify';
import {
  childDatabasePath,
  createAdmin,
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  loginAdmin,
  openControlDatabase,
  redeemDeviceInvite,
  redeemParentInvite,
  setAdminPassword,
  type DeviceKind,
} from '../server/control-db.js';
import { bootstrapLegacyCourses } from '../server/course-catalog.js';
import { CURRICULUM_DIR } from '../server/curriculum.js';
import { ADMIN_COOKIE, CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { buildServer, type ServerOptions } from '../server/index.js';

/** Пароль родителя. Длина — единственное, что о нём проверяет `control.db`. */
export const HARNESS_PASSWORD = 'пароль-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
export const SAME_ORIGIN = 'same-origin';

/**
 * Пароль оператора. Длиннее родительского намеренно: `setAdminPassword` не
 * принимает короче `MIN_ADMIN_PASSWORD_LENGTH` — шестнадцати знаков.
 */
export const HARNESS_ADMIN_PASSWORD = 'пароль-оператора-подлиннее';

/** Заведённый оператор: чем его звать и чем ему входить. */
export interface HarnessAdmin {
  adminId: string;
  email: string;
  password: string;
}

/** Вошедший оператор: токен сессии и заголовки, с которыми он ходит. */
export interface HarnessAdminSession {
  adminId: string;
  /** Токен сессии: он же значение админской cookie. */
  token: string;
  headers: Record<string, string>;
}

/** Заведённый ребёнок: чем ходить от его имени и где лежит его база. */
export interface HarnessChild {
  childId: string;
  /** Постоянный токен устройства: он же значение детской cookie. */
  token: string;
  /** Заголовки, с которыми запрос идёт от имени этого ребёнка. */
  headers: Record<string, string>;
  dbPath: string;
}

export interface TenantServer {
  app: FastifyInstance;
  /** Отдельное соединение управляющей базы: сервер держит своё. */
  control: Database;
  parentId: string;
  parentToken: string;
  /** Заголовки родительской сессии. */
  parentHeaders: Record<string, string>;
  /** Первый ребёнок: от его имени по умолчанию идут все запросы. */
  childId: string;
  childToken: string;
  dbPath: string;
  /** Заводит ещё одного ребёнка того же родителя вместе с устройством. */
  addChild(name?: string, kind?: DeviceKind): HarnessChild;
  /** Заводит второго родителя с ребёнком: тесты изоляции ходят от него. */
  addFamily(email: string, name?: string): {
    parentId: string;
    parentToken: string;
    child: HarnessChild;
  };
  close(): Promise<void>;
}

export interface TenantServerOptions extends Omit<ServerOptions, 'dataDir'> {
  dataDir: string;
  /** Карта тем; по умолчанию репозиторная. */
  curriculumDir?: string;
  /** Адрес родителя, от чьего имени заводится первый ребёнок. */
  email?: string;
  /** Имя первого ребёнка. */
  childName?: string;
}

/**
 * Подставляет заголовки во все `app.inject` этого экземпляра. Явно заданные
 * заголовки вызова сильнее: тесты допуска подменяют cookie на чужую и обязаны
 * получить отказ, а не тихую подстановку своей.
 */
export function withDefaultHeaders(
  app: FastifyInstance,
  headers: Record<string, string>,
): void {
  type SimpleInject = (options: {
    headers?: Record<string, string | string[] | undefined>;
  } & Record<string, unknown>) => Promise<unknown>;
  const original = app.inject.bind(app) as unknown as SimpleInject;
  const patched: SimpleInject = (options) =>
    original({ ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  app.inject = patched as unknown as FastifyInstance['inject'];
}

/** Заголовки запроса от имени детского устройства. */
export function childHeaders(token: string): Record<string, string> {
  return { cookie: `${CHILD_COOKIE}=${token}`, 'sec-fetch-site': SAME_ORIGIN };
}

/** Заголовки запроса от имени вошедшего родителя. */
export function parentHeaders(token: string): Record<string, string> {
  return { cookie: `${PARENT_COOKIE}=${token}`, 'sec-fetch-site': SAME_ORIGIN };
}

/** Заголовки запроса от имени вошедшего оператора. */
export function adminHeaders(token: string): Record<string, string> {
  return { cookie: `${ADMIN_COOKIE}=${token}`, 'sec-fetch-site': SAME_ORIGIN };
}

/**
 * Заводит оператора прямо в `control.db` — тем же путём, каким его заводит CLI:
 * приглашений по ссылке у админки нет вовсе. Подложенная строка `admins` не
 * прошла бы ни проверки длины пароля, ни `scrypt`, и тест на ней проверял бы
 * вход, которого не бывает.
 *
 * Сессии здесь нет намеренно: заводить её и входить — разные события, и
 * сценарию, который входит формой, лишняя живая дверь испортила бы и сводку
 * сессий, и журнал действий.
 */
export function createAdminAccount(
  control: Database,
  options: { email?: string; password?: string; now?: Date } = {},
): HarnessAdmin {
  const email = options.email ?? 'оператор@example.com';
  const password = options.password ?? HARNESS_ADMIN_PASSWORD;
  const at = options.now ?? new Date();
  const adminId = createAdmin(control, email, at);
  setAdminPassword(control, adminId, password, at);
  return { adminId, email, password };
}

/**
 * Входит оператором. Часы передаются те же, что и заведению: `setAdminPassword`
 * двигает `credentials_changed_at`, и сессия, выданная часами позади него,
 * мертва с первого же запроса.
 */
export function signInAdmin(
  control: Database,
  admin: HarnessAdmin,
  now: Date = new Date(),
): HarnessAdminSession {
  const login = loginAdmin(control, admin.email, admin.password, now);
  if (!login.ok) throw new Error(`тестовый оператор ${admin.email} не вошёл: ${login.reason}`);
  return {
    adminId: login.adminId,
    token: login.session.token,
    headers: adminHeaders(login.session.token),
  };
}

/** Заголовки запроса от имени агента доступа к компьютеру. */
export function agentHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'sec-fetch-site': SAME_ORIGIN };
}

/**
 * Поднимает сервер и заводит в нём готового к занятию ребёнка.
 *
 * Аренда сразу же прогревается запросом: реестр открывает базу по первому
 * обращению, а тесты правят `topic_state` и банк заданий **до** первого
 * запроса, и без прогрева правка уходила бы в базу без единой строки тем.
 */
export async function startTenantServer(options: TenantServerOptions): Promise<TenantServer> {
  const { curriculumDir, email, childName, ...serverOptions } = options;
  const dataDir = ensureDataDir(options.dataDir);
  const app = buildServer(curriculumDir, {
    ...serverOptions,
    // Маршрутные тесты проверяют HTTP и доменную логику, а не внешний Codex.
    // Специальные integrity-тесты передают свой reviewer и перекрывают этот.
    integrityReview: serverOptions.integrityReview ?? (async (items) => items.map((item) => ({
      id: item.id,
      decision: 'meaningful' as const,
      confidence: 0.99,
      reason: 'Тестовый осмысленный ответ.',
    }))),
  });
  await app.ready();

  const control = openControlDatabase(controlDatabasePath(dataDir));
  const now = options.now ?? ((): Date => new Date());

  /** Родитель с установленным паролем: наружу нужны его `id` и токен сессии. */
  function newParent(address: string): { parentId: string; token: string } {
    const parentId = createParent(control, address, now());
    const invite = issueParentInvite(control, parentId, now());
    const redeemed = redeemParentInvite(control, invite.token, HARNESS_PASSWORD, now());
    if (!redeemed.ok) throw new Error(`тестовый родитель ${address} не завёл пароль`);
    return { parentId, token: redeemed.session.token };
  }

  /** Ребёнок с заведённой базой и погашенным приглашением устройства. */
  function newChild(parentId: string, name: string, kind: DeviceKind): HarnessChild {
    const childId = createChild(control, parentId, name, now());
    provisionChildDatabase(control, childId, dataDir);
    const invite = issueDeviceInvite(control, childId, kind, name, now());
    const claim = redeemDeviceInvite(control, invite.token, now());
    if (!claim.ok) throw new Error(`тестовое устройство ребёнка ${childId} не погашено`);
    return {
      childId,
      token: claim.token,
      headers: kind === 'agent' ? agentHeaders(claim.token) : childHeaders(claim.token),
      dbPath: childDatabasePath(dataDir, childId),
    };
  }

  const parent = newParent(email ?? 'родитель@example.com');
  const child = newChild(parent.parentId, childName ?? 'Ученик', 'browser');
  // buildServer выполняет bootstrap до появления тестового ребёнка. Повторный
  // вызов назначает legacy-курсы только новому ребёнку и не восстанавливает
  // когда-либо снятые назначения.
  bootstrapLegacyCourses(control, curriculumDir ?? CURRICULUM_DIR);
  withDefaultHeaders(app, child.headers);

  // Прогрев аренды: он же проверяет, что собранный допуск действительно
  // пропускает заведённое устройство, — иначе тест падал бы позже и не по делу.
  const warmed = await app.inject({ method: 'GET', url: '/api/gate/status' });
  if (warmed.statusCode !== 200) {
    throw new Error(`аренда ребёнка ${child.childId} не открылась: ${warmed.statusCode}`);
  }

  return {
    app,
    control,
    parentId: parent.parentId,
    parentToken: parent.token,
    parentHeaders: parentHeaders(parent.token),
    childId: child.childId,
    childToken: child.token,
    dbPath: child.dbPath,
    addChild: (name = 'Второй', kind: DeviceKind = 'browser') =>
      newChild(parent.parentId, name, kind),
    addFamily: (address, name = 'Чужой') => {
      const other = newParent(address);
      return {
        parentId: other.parentId,
        parentToken: other.token,
        child: newChild(other.parentId, name, 'browser'),
      };
    },
    async close(): Promise<void> {
      await app.close();
      control.close();
    },
  };
}

/**
 * Журнал аварий, который никуда не пишет, но всё помнит. Маршрутные тесты
 * поднимают вход без каталога данных, а `failures` у него обязателен: настоящий
 * `failureLogFor` завёл бы файл в каталоге, которого у теста нет.
 */
export function recordingFailureLog(): {
  (record: FailureRecord): void;
  records: FailureRecord[];
} {
  const records: FailureRecord[] = [];
  const log = (record: FailureRecord): void => { records.push(record); };
  return Object.assign(log, { records });
}
