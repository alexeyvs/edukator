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
import type { FastifyInstance } from 'fastify';
import {
  childDatabasePath,
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  openControlDatabase,
  redeemDeviceInvite,
  redeemParentInvite,
  type DeviceKind,
} from '../server/control-db.js';
import { CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { buildServer, type ServerOptions } from '../server/index.js';

/** Пароль родителя. Длина — единственное, что о нём проверяет `control.db`. */
export const HARNESS_PASSWORD = 'пароль-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
export const SAME_ORIGIN = 'same-origin';

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
  const app = buildServer(curriculumDir, serverOptions);
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
