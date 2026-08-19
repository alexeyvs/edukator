/**
 * Разрешение предъявителя запроса и его аренды.
 *
 * Предъявителей ровно три: `parent` (cookie родительской сессии), `browser`
 * (cookie детского устройства) и `agent` (токен заголовком). Агент — **не**
 * детская сессия: за ним стоит контроллер доступа к компьютеру, которому нужен
 * один read-only маршрут, и допуск его к обычным детским маршрутам означал бы,
 * что токен из файла настройки на детской машине умеет сдавать ответы.
 *
 * Порядок разрешения жёсткий: разобрать предъявителя → **одной выборкой**
 * проверить принадлежность ребёнка → и только затем открыть его базу. Обратный
 * порядок стоил бы дорого не соединением, а тем, что `runId` и `itemId`
 * нумеруются в каждой базе с нуля: ошибка выбора базы кончается не отказом, а
 * успешной операцией над чужой строкой с тем же номером.
 */
import type Database from 'better-sqlite3';
import {
  CHILD_ID_PATTERN,
  isChildServiceable,
  readChild,
  resolveChildDevice,
  resolveParentSession,
  type ChildPrincipal,
  type ChildSummary,
  type ParentPrincipal,
} from './control-db.js';
import { TenantError, type Tenant } from './tenant-registry.js';

/**
 * Имя cookie родительской сессии. Префикс `__Host-` — не украшение: он
 * запрещает браузеру принимать такую cookie без `Secure`, с `Domain` и с
 * `Path` короче корня, то есть закрывает подкладывание её поддоменом.
 */
export const PARENT_COOKIE = '__Host-edu_parent';

/** Имя cookie детского устройства. Тот же префикс и по той же причине. */
export const CHILD_COOKIE = '__Host-edu_child';

/**
 * Заголовок агентского токена. Схема `Bearer`, а не cookie: контроллер ходит из
 * Python, cookie ему не нужны, а заголовок к тому же не досылается браузером
 * автоматически — то есть с чужой страницы агентом не притвориться.
 */
export const AGENT_HEADER = 'authorization';

const AGENT_SCHEME = 'bearer';

/** Методы, которые ничего не меняют: с них проверка источника не спрашивается. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type BearerKind = 'parent' | 'browser' | 'agent';

/** Предъявитель запроса. Родитель приходит без ребёнка, устройство — со своим. */
export type Bearer =
  | { kind: 'parent'; parent: ParentPrincipal }
  | { kind: 'browser'; child: ChildPrincipal }
  | { kind: 'agent'; child: ChildPrincipal };

/** Причина отказа допуска. По ней маршрут выбирает код и текст ответа. */
export type AuthErrorCode =
  /** Предъявителя нет вовсе или он уже недействителен. */
  | 'unauthenticated'
  /** Предъявитель есть, но этому виду сюда нельзя. */
  | 'forbidden'
  /** Изменяющий запрос не подтвердил, что пришёл со своей же страницы. */
  | 'cross-origin'
  /** Нет такого ребёнка **или** он не ваш: снаружи это одно и то же. */
  | 'no-child'
  /** Потолок открытых баз исчерпан. */
  | 'too-many-open'
  /** База ребёнка недоступна. */
  | 'unavailable';

/** Код ответа на отказ допуска. */
export const AUTH_STATUS: Record<AuthErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  'cross-origin': 403,
  'no-child': 404,
  'too-many-open': 503,
  unavailable: 503,
};

/**
 * Текст ответа на отказ допуска. У `no-child` он один на два разных случая
 * намеренно: разные тексты превратили бы перебор `id` в справочник заведённых
 * детей, а сам `id` — в достаточный признак «этот существует».
 */
export const AUTH_MESSAGE: Record<AuthErrorCode, string> = {
  unauthenticated: 'Нужно войти',
  forbidden: 'Доступ закрыт',
  'cross-origin': 'Запрос пришёл не со страницы приложения',
  'no-child': 'Ребёнок не найден',
  'too-many-open': 'Сервер занят, попробуйте позже',
  unavailable: 'База ребёнка недоступна',
};

/** Отказ допуска по состоянию, а не по поломке кода: маршрут отвечает 4xx/503. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Заголовки запроса в том виде, в каком их отдаёт Node. */
export type RequestHeaders = Record<string, string | string[] | undefined>;

/**
 * Одно значение заголовка. Массив склеивается, а не берётся первым элементом:
 * дважды присланный `Cookie` не должен молча терять половину, иначе
 * предъявитель зависел бы от того, как клиент разложил заголовок.
 */
export function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

/**
 * Разбирает `Cookie`. Дубликат имени выигрывает первым: браузер ставит впереди
 * cookie с более длинным `Path`, и подсунутая соседним путём копия не должна
 * подменять собой ту, что выдал сам сервер.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === undefined) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || jar.has(name)) continue;
    jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}

/** Агентский токен из `Authorization: Bearer`. Чужая схема — не наш токен. */
export function readAgentToken(headers: RequestHeaders): string | undefined {
  const raw = headerValue(headers, AGENT_HEADER);
  if (raw === undefined) return undefined;
  const space = raw.indexOf(' ');
  if (space <= 0) return undefined;
  if (raw.slice(0, space).toLowerCase() !== AGENT_SCHEME) return undefined;
  const token = raw.slice(space + 1).trim();
  return token === '' ? undefined : token;
}

/**
 * Разбирает предъявителя. `undefined` — отказ по любой причине: снаружи «нет
 * cookie», «сессия погасла» и «устройство отозвано» неразличимы.
 *
 * Детская cookie сильнее родительской, когда пришли обе: за детской машиной
 * сидит ученик, и родительский вход, забытый там после настройки, не должен
 * молча превращать его занятие в родительское. Обратный порядок к тому же
 * подсказывал бы способ поднять себе права — достаточно один раз войти
 * родителем на том же компьютере.
 *
 * Вид устройства сверяется с каналом, по которому пришёл токен: агентский токен
 * в детской cookie предъявителем не служит, как и детский в заголовке. Без
 * сверки агент получал бы обычную детскую сессию простой перекладкой строки.
 */
export function resolveBearer(
  control: Database.Database,
  headers: RequestHeaders,
  now: Date = new Date(),
): Bearer | undefined {
  const jar = parseCookies(headerValue(headers, 'cookie'));

  const childToken = jar.get(CHILD_COOKIE);
  if (childToken !== undefined) {
    const child = resolveChildDevice(control, childToken, now);
    if (child !== undefined && child.kind === 'browser') return { kind: 'browser', child };
  }

  const agentToken = readAgentToken(headers);
  if (agentToken !== undefined) {
    const child = resolveChildDevice(control, agentToken, now);
    if (child !== undefined && child.kind === 'agent') return { kind: 'agent', child };
  }

  // Недействительная детская cookie родительскую сессию не отменяет: родитель
  // настраивает ребёнка с его же машины, и отозванное там устройство иначе
  // закрывало бы вход тому, кто его отозвал.
  const parentToken = jar.get(PARENT_COOKIE);
  if (parentToken !== undefined) {
    const parent = resolveParentSession(control, parentToken, now);
    if (parent !== undefined) return { kind: 'parent', parent };
  }

  return undefined;
}

/** Меняет ли запрос состояние. От этого зависит проверка источника. */
export function isMutating(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Пришёл ли запрос со своей же страницы.
 *
 * `SameSite` защитой от CSRF не считается: `Lax` пропускает переходы верхнего
 * уровня, значение по умолчанию у части клиентов до сих пор `None`, а браузер
 * без поддержки атрибута просто игнорирует его. Поэтому изменяющий запрос
 * обязан подтвердить источник сам — либо совпадением `Origin` с хостом
 * запроса, либо `Sec-Fetch-Site: same-origin`.
 *
 * Присланный `Origin` проверяется всегда, даже когда `Sec-Fetch-Site` говорит
 * `same-origin`: одновременно эти два заголовка расходятся только у того, кто
 * их подделывает, и верить в такой паре надо более строгому.
 */
export function isSameOrigin(headers: RequestHeaders): boolean {
  const origin = headerValue(headers, 'origin');
  if (origin !== undefined && origin !== '') {
    // `null` — непрозрачный источник (sandbox, `data:`), то есть заведомо чужой.
    if (origin === 'null') return false;
    const host = headerValue(headers, 'host');
    if (host === undefined) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return parsed.host.toLowerCase() === host.toLowerCase();
  }
  return headerValue(headers, 'sec-fetch-site') === 'same-origin';
}

/**
 * Требует подтверждённый источник у изменяющего запроса. Отсутствие обоих
 * заголовков — тоже отказ: неизвестный источник и есть чужой.
 */
export function assertSameOrigin(method: string, headers: RequestHeaders): void {
  if (!isMutating(method)) return;
  if (isSameOrigin(headers)) return;
  throw new AuthError('cross-origin', `Изменяющий запрос ${method} без подтверждённого источника`);
}

/** Кого пускают по умолчанию. Агента приходится называть явно — см. `resolveTenant`. */
export const DEFAULT_ALLOWED: readonly BearerKind[] = ['parent', 'browser'];

/** Ребёнок предъявителя, если он детский. У родителя своего ребёнка нет. */
function bearerChildId(bearer: Bearer): string | undefined {
  return bearer.kind === 'parent' ? undefined : bearer.child.childId;
}

/** Родитель, от имени которого идёт запрос. У детского предъявителя — его же родитель. */
function bearerParentId(bearer: Bearer): string {
  return bearer.kind === 'parent' ? bearer.parent.parentId : bearer.child.parentId;
}

/**
 * Проверяет принадлежность ребёнка предъявителю **одной выборкой** до всякого
 * открытия базы. Все отказы — один код и один текст: «не ваш ребёнок» обязан
 * быть неотличим от «нет такого ребёнка».
 *
 * `childId` из адреса у детского предъявителя допускается только свой: ребёнок
 * ходит на собственные маршруты без него, но родительские маршруты его именуют,
 * и чужой `id` там — попытка изоляции, а не опечатка.
 */
export function authorizeChild(
  control: Database.Database,
  bearer: Bearer,
  childId?: string,
): ChildSummary {
  const own = bearerChildId(bearer);
  const target = childId ?? own;
  if (target === undefined) {
    throw new AuthError('no-child', 'Родительскому запросу нужен ребёнок в адресе');
  }
  if (own !== undefined && target !== own) {
    throw new AuthError('no-child', `Предъявитель ${own} просит чужого ребёнка`);
  }
  // Формат проверяется до базы: `id` служит именем файла, и всё, кроме
  // шестнадцатеричных знаков, — это чужой путь, а не отсутствующая строка.
  if (!CHILD_ID_PATTERN.test(target)) {
    throw new AuthError('no-child', 'Недопустимый идентификатор ребёнка');
  }

  const child = readChild(control, target);
  if (child === undefined || !isChildServiceable(child)) {
    throw new AuthError('no-child', `Ребёнок ${target} не обслуживается`);
  }
  if (child.parentId !== bearerParentId(bearer)) {
    throw new AuthError('no-child', `Ребёнок ${target} принадлежит другому родителю`);
  }
  return child;
}

/** Реестр в том объёме, в каком его знает допуск: открыть базу по `id`. */
export interface TenantOpener {
  open(childId: string): Tenant;
}

/** Итог разрешения: кто пришёл, к какому ребёнку и с какой базой. */
export interface ResolvedTenant {
  bearer: Bearer;
  child: ChildSummary;
  tenant: Tenant;
}

export interface ResolveTenantOptions {
  control: Database.Database;
  tenants: TenantOpener;
  headers: RequestHeaders;
  method: string;
  /** Ребёнок из адреса. У детских маршрутов его нет: там ребёнок — сам предъявитель. */
  childId?: string;
  /** Кого пускать. Агента приходится называть явно: по умолчанию его нет. */
  allow?: readonly BearerKind[];
  now?: Date;
}

/**
 * Полный путь допуска: источник → предъявитель → принадлежность → база.
 *
 * Проверка источника идёт первой, до всякого обращения к управляющей базе:
 * разбор предъявителя подновляет `last_seen_at` и `last_activity_at`, то есть
 * пишет, и чужая страница не должна уметь заставить нас это сделать.
 */
export function resolveTenant(options: ResolveTenantOptions): ResolvedTenant {
  const allow = options.allow ?? DEFAULT_ALLOWED;
  assertSameOrigin(options.method, options.headers);

  const bearer = resolveBearer(options.control, options.headers, options.now ?? new Date());
  if (bearer === undefined) throw new AuthError('unauthenticated', 'Предъявитель не разобран');
  if (!allow.includes(bearer.kind)) {
    throw new AuthError('forbidden', `Предъявителю ${bearer.kind} сюда нельзя`);
  }

  const child = authorizeChild(options.control, bearer, options.childId);
  return { bearer, child, tenant: openTenant(options.tenants, child.id) };
}

/**
 * Открывает базу ребёнка, переводя отказ реестра в отказ допуска.
 * `not-serviceable` здесь — гонка с выводом ребёнка между проверкой и
 * открытием, и снаружи она обязана выглядеть так же, как чужой `id`.
 */
function openTenant(tenants: TenantOpener, childId: string): Tenant {
  try {
    return tenants.open(childId);
  } catch (error) {
    if (!(error instanceof TenantError)) throw error;
    if (error.code === 'not-serviceable') {
      throw new AuthError('no-child', `Ребёнок ${childId} не обслуживается`);
    }
    throw new AuthError(error.code, error.message);
  }
}
