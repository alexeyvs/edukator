/**
 * Источник базы для маршрутов: контекст запроса вместо замыкания сервера.
 *
 * Однопользовательский сервер раздавал маршрутам одно соединение при старте, и
 * состав маршрутов навсегда выбирался по тому, поднялась ли та единственная
 * база. Здесь база выбирается на каждый запрос — по предъявителю, — и вместе с
 * ней приходит всё, что было привязано к арендатору: признак подмены файла и
 * координатор споров.
 *
 * Здесь же живёт матрица допуска. Своя таблица `allow` в каждом маршруте
 * разъехалась бы молча: «агенту сюда нельзя» — это утверждение обо всех
 * маршрутах разом, и проверять его надо в одном месте, а не в восьми.
 */
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AUTH_MESSAGE,
  AUTH_STATUS,
  AuthError,
  resolveTenant,
  type BearerKind,
  type ResolvedTenant,
  type TenantOpener,
} from '../auth.js';
import type { ChildSummary } from '../control-db.js';
import type { Tenant } from '../tenant-registry.js';

/** Кто пришёл, к какому ребёнку и с какой базой. */
export type TenantContext = ResolvedTenant;

/** Что маршрут знает про допуск: кого пускать и какой ребёнок назван в адресе. */
export interface TenantContextOptions {
  allow?: readonly BearerKind[];
  /** Ребёнок из адреса; у детских маршрутов его нет — там ребёнок сам предъявитель. */
  childId?: string;
}

/**
 * Разрешение запроса в аренду. Бросает `AuthError`: отказ допуска — обычный
 * ответ 4xx/503, а не поломка, и переводит его в ответ `failAuth`.
 */
export type TenantContextResolver = (
  request: FastifyRequest,
  options?: TenantContextOptions,
) => TenantContext;

/**
 * Матрица допуска. Строка — группа маршрутов, значение — виды предъявителя,
 * которым она открыта.
 *
 * `child` закрыт родителю намеренно: занятие сдаёт ученик, и родительская
 * сессия, умеющая ответить за него, обесценивала бы и mastery, и прогноз.
 * Отказ здесь честный 403, а не 404 «нет такого ребёнка»: родитель никакого
 * ребёнка в адресе и не называл.
 *
 * `gate` — единственная строка с агентом: за ним стоит контроллер доступа к
 * компьютеру, которому нужно состояние дневного гейта и больше ничего.
 *
 * `dashboard` открыт и ученику: по основной спеке он видит тот же дашборд, что
 * и родитель, и знает о нём. Изменяющие маршруты этой группы требуют PIN
 * (см. `server/routes/parents.ts`) — но у родительской сессии он не
 * спрашивается: PIN подтверждает родителя за детской машиной, а вошедший
 * родитель уже подтверждён паролем.
 */
export const ROUTE_ACCESS = {
  child: ['browser'],
  gate: ['browser', 'agent'],
  dashboard: ['parent', 'browser'],
} as const satisfies Record<string, readonly BearerKind[]>;

/** Отвечает на отказ допуска. Чужие ошибки пролетают наверх пятисоткой. */
export function failAuth(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof AuthError)) throw error;
  return reply.code(AUTH_STATUS[error.code]).send({ error: AUTH_MESSAGE[error.code] });
}

/** Ребёнок из адреса. Значение не проверяется здесь: это делает `authorizeChild`. */
export function childIdParam(params: unknown): string {
  return (params as { childId: string }).childId;
}

export interface CreateTenantContextOptions {
  /** Управляющая база: по ней разбирается предъявитель и его ребёнок. */
  control: Database.Database;
  /** Реестр детских баз. */
  tenants: TenantOpener;
  now?: () => Date;
}

/** Рабочее разрешение: предъявитель из заголовков, ребёнок из управляющей базы. */
export function createTenantContext(options: CreateTenantContextOptions): TenantContextResolver {
  const now = options.now ?? ((): Date => new Date());
  return (request, context = {}) =>
    resolveTenant({
      control: options.control,
      tenants: options.tenants,
      headers: request.headers,
      method: request.method,
      now: now(),
      ...(context.allow === undefined ? {} : { allow: context.allow }),
      ...(context.childId === undefined ? {} : { childId: context.childId }),
    });
}

/**
 * Идентификатор ребёнка единственной базы. Он нужен, пока `buildServer` держит
 * одну базу и ещё не открывает управляющую (задача 15): маршруты уже спрашивают
 * ребёнка контекстом, а называть его в адресе всё равно чем-то надо.
 */
export const SINGLE_TENANT_CHILD_ID = '00000000';

/**
 * Разрешение для сервера с единственной базой — временная опора до задачи 15,
 * пока `buildServer` не открывает `control.db` и не собирает реестр.
 *
 * Предъявитель здесь один и тот же, детский: у беспарольного сервера никакого
 * другого и не было. Проверять он умеет ровно одно — что названный в адресе
 * ребёнок тот самый; чужой `id` отсюда отвечает так же, как из рабочего
 * разрешения, а не открывает единственную базу под чужим именем.
 */
export function singleTenantContext(tenant: Tenant): TenantContextResolver {
  const child: ChildSummary = {
    id: tenant.childId,
    parentId: tenant.childId,
    name: 'Ученик',
    status: 'ready',
    createdAt: new Date(0).toISOString(),
  };
  return (_request, context = {}) => {
    if (context.childId !== undefined && context.childId !== tenant.childId) {
      throw new AuthError('no-child', `Ребёнок ${context.childId} не обслуживается`);
    }
    const allow = context.allow;
    if (allow !== undefined && !allow.includes('browser')) {
      throw new AuthError('forbidden', 'Предъявителю browser сюда нельзя');
    }
    return {
      bearer: {
        kind: 'browser',
        child: {
          childId: tenant.childId,
          parentId: tenant.childId,
          deviceId: 1,
          kind: 'browser',
          name: child.name,
        },
      },
      child,
      tenant,
    };
  };
}
