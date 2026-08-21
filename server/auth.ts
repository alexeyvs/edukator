/**
 * Разрешение предъявителя запроса и его аренды.
 *
 * Предъявителей четыре: `parent` (cookie родительской сессии), `browser`
 * (cookie детского устройства), `agent` (токен заголовком) и `admin` (cookie
 * оператора). Первые три ходят в аренду, четвёртый — мимо неё: у админских
 * маршрутов ребёнка нет вовсе, и разбирает их отдельный `resolveAdmin`. Агент — **не**
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
  readParentEmail,
  resolveAdminSession,
  resolveChildDevice,
  resolveImpersonation,
  resolveParentSession,
  type AdminPrincipal,
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

/** Явно выбранная роль браузера, когда в нём живы обе сессии. */
export const ACTOR_COOKIE = '__Host-edu_actor';

/**
 * Имя cookie сессии оператора. Тот же префикс `__Host-` и по той же причине.
 * Отдельное имя, а не общее с родительским: одна cookie на две роли означала
 * бы, что вход оператора выбрасывает его же родительский вход на той же машине.
 */
export const ADMIN_COOKIE = '__Host-edu_admin';

/**
 * Имя cookie захода в чужую семью. Живёт **рядом** с админской, а не вместо
 * неё: выход из имперсонации обязан возвращать оператора в админку, а не
 * выбрасывать его на экран входа.
 */
export const IMPERSONATION_COOKIE = '__Host-edu_impersonation';

/**
 * Заголовок агентского токена. Схема `Bearer`, а не cookie: контроллер ходит из
 * Python, cookie ему не нужны, а заголовок к тому же не досылается браузером
 * автоматически — то есть с чужой страницы агентом не притвориться.
 */
export const AGENT_HEADER = 'authorization';

const AGENT_SCHEME = 'bearer';

/** Методы, которые ничего не меняют: с них проверка источника не спрашивается. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type BearerKind = 'parent' | 'browser' | 'agent' | 'admin';

/**
 * Отметка «этот предъявитель — заход оператора в чужую семью». Она едет полем
 * обычного предъявителя, а не новым `BearerKind`: иначе `admin`-как-ребёнок
 * пришлось бы вписывать в каждую строку матрицы `ROUTE_ACCESS`, и забытая
 * строка закрывала бы оператору ровно тот маршрут, ради которого он зашёл.
 */
export interface ImpersonationMark {
  adminId: string;
  expiresAt: string;
}

/**
 * Предъявитель запроса. Родитель приходит без ребёнка, устройство — со своим.
 *
 * `impersonation` у агента объявлен `never` намеренно: роли захода ровно две
 * (`browser` и `parent`), и «оператор притворился контроллером доступа»
 * обязано быть невозможным на сборке, а не отсеиваться проверкой.
 */
export type Bearer =
  | { kind: 'parent'; parent: ParentPrincipal; impersonation?: ImpersonationMark }
  | { kind: 'browser'; child: ChildPrincipal; impersonation?: ImpersonationMark }
  | { kind: 'agent'; child: ChildPrincipal; impersonation?: never };

/** Действительные браузерные предъявители без выбора приоритета между ними. */
export interface BrowserPrincipals {
  parent?: ParentPrincipal;
  child?: ChildPrincipal;
}

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
  /** Оператор смотрит чужую семью и пытается её изменить. */
  | 'read-only'
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
  'read-only': 403,
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
  'read-only': 'Только просмотр: вы в чужой семье',
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
 *
 * Разделитель зависит от заголовка. `; ` — правило `Cookie` и только его: тем же
 * швом сшитый `X-Forwarded-For` перестал бы разбираться `clientAddress`, который
 * режет цепочку по запятой, — то есть счётчик перебора считал бы всю цепочку
 * одним неразобранным адресом.
 */
export function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const lowered = name.toLowerCase();
  const raw = headers[lowered];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join(lowered === 'cookie' ? '; ' : ', ') : raw;
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

  // Заход оператора проверяется **первым** и перекрывает собственные cookie:
  // оператор заходит в чужую семью со своей же машины, где живы и его
  // родительский, и его детский вход, и проигравший заход показывал бы ему
  // собственные данные под баннером чужой семьи.
  const impersonated = resolveImpersonatedBearer(control, jar, now);
  if (impersonated !== undefined) return impersonated;

  const browser = resolveBrowserPrincipals(control, headers, now);

  // Явный выбор действует только пока обе сессии действительно живы. Cookie
  // предпочтения сама по себе прав не даёт: её значение всегда подтверждается
  // серверными сессиями ниже.
  if (browser.parent !== undefined && browser.child !== undefined) {
    if (jar.get(ACTOR_COOKIE) === 'parent') return { kind: 'parent', parent: browser.parent };
    return { kind: 'browser', child: browser.child };
  }

  if (browser.child !== undefined) return { kind: 'browser', child: browser.child };

  const agentToken = readAgentToken(headers);
  if (agentToken !== undefined) {
    const child = resolveChildDevice(control, agentToken, now);
    if (child !== undefined && child.kind === 'agent') return { kind: 'agent', child };
  }

  // Недействительная детская cookie родительскую сессию не отменяет: родитель
  // настраивает ребёнка с его же машины, и отозванное там устройство иначе
  // закрывало бы вход тому, кто его отозвал.
  if (browser.parent !== undefined) return { kind: 'parent', parent: browser.parent };

  return undefined;
}

/**
 * Разбирает cookie захода в чужую семью в обычного предъявителя целевой семьи.
 * `undefined` — отказ по любой причине: «нет такой», «истекла», «оператора
 * отключили» и «семью вывели» снаружи неразличимы.
 *
 * Ни `children.last_activity_at`, ни `last_seen_at` целевого родителя здесь не
 * подновляются: чужие данные читает оператор, а не ребёнок вернулся за экран.
 */
function resolveImpersonatedBearer(
  control: Database.Database,
  jar: Map<string, string>,
  now: Date,
): Bearer | undefined {
  const token = jar.get(IMPERSONATION_COOKIE);
  if (token === undefined) return undefined;
  const session = resolveImpersonation(control, token, now);
  if (session === undefined) return undefined;
  const impersonation: ImpersonationMark = {
    adminId: session.adminId,
    expiresAt: session.expiresAt,
  };

  if (session.role === 'parent') {
    // Адрес читается заново, а не хранится в строке захода: отключённый с тех
    // пор родитель обязан закрыть и заход, как закрывает собственный вход.
    const email = readParentEmail(control, session.parentId);
    if (email === undefined) return undefined;
    return { kind: 'parent', parent: { parentId: session.parentId, email }, impersonation };
  }

  return {
    kind: 'browser',
    child: {
      childId: session.childId,
      parentId: session.parentId,
      kind: 'browser',
      name: session.childName,
    },
    impersonation,
  };
}

/**
 * Проверяет обе браузерные cookie независимо. Нужна `/api/auth/me`: выбор
 * активной роли не должен скрывать вторую живую сессию от переключателя.
 */
export function resolveBrowserPrincipals(
  control: Database.Database,
  headers: RequestHeaders,
  now: Date = new Date(),
): BrowserPrincipals {
  const jar = parseCookies(headerValue(headers, 'cookie'));
  const result: BrowserPrincipals = {};
  const childToken = jar.get(CHILD_COOKIE);
  if (childToken !== undefined) {
    const child = resolveChildDevice(control, childToken, now);
    if (child !== undefined && child.kind === 'browser') result.child = child;
  }
  const parentToken = jar.get(PARENT_COOKIE);
  if (parentToken !== undefined) {
    const parent = resolveParentSession(control, parentToken, now);
    if (parent !== undefined) result.parent = parent;
  }
  return result;
}

/** Предъявитель админки. Ребёнка он не называет: аренды у его маршрутов нет. */
export interface AdminBearer {
  kind: 'admin';
  admin: AdminPrincipal;
}

/**
 * Разрешает cookie оператора. Смотрит **только** `__Host-edu_admin`: ни детская,
 * ни родительская cookie здесь не участвуют, и приоритета между ними нет —
 * админка живёт рядом с обычным приложением, а не вместо него.
 */
export function resolveAdminBearer(
  control: Database.Database,
  headers: RequestHeaders,
  now: Date = new Date(),
): AdminBearer | undefined {
  const token = parseCookies(headerValue(headers, 'cookie')).get(ADMIN_COOKIE);
  if (token === undefined) return undefined;
  const admin = resolveAdminSession(control, token, now);
  return admin === undefined ? undefined : { kind: 'admin', admin };
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
 *
 * `mutating` поднимает до изменяющего и безопасный по методу запрос: `GET`
 * `/api/session/next` списывает задание из банка безвозвратно, а детская cookie
 * `SameSite=Lax` уезжает и на переходе с чужой страницы. Решает не метод, а то,
 * что маршрут делает.
 */
export function assertSameOrigin(
  method: string,
  headers: RequestHeaders,
  mutating = false,
): void {
  if (!mutating && !isMutating(method)) return;
  if (isSameOrigin(headers)) return;
  throw new AuthError('cross-origin', `Изменяющий запрос ${method} без подтверждённого источника`);
}

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

/**
 * Реестр в том объёме, в каком его знает допуск: открыть базу по `id`.
 *
 * Вид предъявителя передаётся вместе с `id` не ради самого открытия, а ради
 * будильника прогрева: «ребёнок вернулся» — это только `browser`. Опрос агента
 * активностью не считается ни в `children.last_activity_at`, ни здесь.
 */
export interface TenantOpener {
  open(childId: string, bearer: BearerKind): Tenant;
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
  /**
   * Кого пускать. Поле обязательное намеренно: умолчание «родитель и браузер»
   * означало бы, что забытый `allow` у нового маршрута открывает его молча и
   * вширь, а не падает на сборке.
   */
  allow: readonly BearerKind[];
  /**
   * Маршрут меняет состояние независимо от метода: `GET`, списывающий задание,
   * подтверждает источник наравне с `POST`.
   */
  mutating?: boolean;
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
  const allow = options.allow;
  assertSameOrigin(options.method, options.headers, options.mutating === true);

  const bearer = resolveBearer(options.control, options.headers, options.now ?? new Date());
  if (bearer === undefined) throw new AuthError('unauthenticated', 'Предъявитель не разобран');
  if (!allow.includes(bearer.kind)) {
    throw new AuthError('forbidden', `Предъявителю ${bearer.kind} сюда нельзя`);
  }

  // Первый замок имперсонации. Он стоит до `authorizeChild` намеренно: сам
  // разбор принадлежности ничего не пишет, но открывать чужую базу ради
  // запроса, которому всё равно откажут, незачем. Второй замок —
  // `PRAGMA query_only` на отдельном соединении — независим от этого и
  // переживает забытый `mutating` у нового маршрута.
  if (bearer.impersonation !== undefined && (isMutating(options.method) || options.mutating === true)) {
    throw new AuthError(
      'read-only',
      `Оператор ${bearer.impersonation.adminId} смотрит чужую семью и не меняет её`,
    );
  }

  const child = authorizeChild(options.control, bearer, options.childId);
  return { bearer, child, tenant: openTenant(options.tenants, child.id, bearer.kind) };
}

/**
 * Открывает базу ребёнка, переводя отказ реестра в отказ допуска.
 * `not-serviceable` здесь — гонка с выводом ребёнка между проверкой и
 * открытием, и снаружи она обязана выглядеть так же, как чужой `id`.
 */
function openTenant(tenants: TenantOpener, childId: string, bearer: BearerKind): Tenant {
  try {
    return tenants.open(childId, bearer);
  } catch (error) {
    if (!(error instanceof TenantError)) throw error;
    if (error.code === 'not-serviceable') {
      throw new AuthError('no-child', `Ребёнок ${childId} не обслуживается`);
    }
    throw new AuthError(error.code, error.message);
  }
}

export interface ResolveAdminOptions {
  control: Database.Database;
  headers: RequestHeaders;
  method: string;
  /**
   * Кого пускать. Поле обязательное по той же причине, что и у аренды: строка
   * матрицы у маршрута должна быть выписана, а не подразумеваться.
   */
  allow: readonly BearerKind[];
  /** Маршрут меняет состояние независимо от метода. */
  mutating?: boolean;
  now?: Date;
}

/**
 * Полный путь допуска оператора: источник → предъявитель. Аренды в нём нет
 * вовсе, и `resolveTenant` админским маршрутам не нужен: приоритет
 * имперсонации иначе возвращал бы на `/api/admin/*` предъявителя целевой
 * семьи, и админка отказывала бы ровно тогда, когда оператор в имперсонации и
 * хочет из неё выйти.
 *
 * Проверка источника идёт первой и здесь: разбор сессии подновляет
 * `last_seen_at`, то есть пишет, и чужая страница не должна уметь заставить нас
 * это сделать.
 */
export function resolveAdmin(options: ResolveAdminOptions): AdminBearer {
  assertSameOrigin(options.method, options.headers, options.mutating === true);
  if (!options.allow.includes('admin')) {
    throw new AuthError('forbidden', 'Маршрут не открыт оператору');
  }
  const bearer = resolveAdminBearer(options.control, options.headers, options.now ?? new Date());
  if (bearer === undefined) throw new AuthError('unauthenticated', 'Оператор не разобран');
  return bearer;
}
