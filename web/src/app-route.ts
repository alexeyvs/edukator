import type { AuthState, Impersonation } from './auth-api';

/** Страница по ссылке: приглашение родителя или погашение детского устройства. */
export interface LinkPage {
  kind: 'invite' | 'join';
  token: string;
}

const LINK_PREFIXES: ReadonlyArray<[string, LinkPage['kind']]> = [
  ['/invite/', 'invite'],
  ['/join/', 'join'],
];

/**
 * Токен из адреса страницы. Пустой и составной сегменты — не токен: сервер
 * такие страницы и не отдаёт, а разбирать их здесь значило бы носить по
 * приложению строку, которая ничего не открывает.
 *
 * Битая процентная последовательность (`/join/%`) — тоже «не токен», а не
 * исключение: `decodeURIComponent` бросает на ней `URIError`, а зовётся разбор
 * из инициализатора состояния корневого компонента, где вылет означает белый
 * экран без единого слова вместо экрана «ссылка не работает».
 */
export function readLinkPage(pathname: string): LinkPage | null {
  for (const [prefix, kind] of LINK_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    let token: string;
    try {
      token = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return null;
    }
    if (token !== '' && !token.includes('/')) return { kind, token };
  }
  return null;
}

/** Адрес админки: её корень и карточка ребёнка внутри неё. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * Что рисует корень приложения. Состояний шесть, и они не пересекаются:
 * `pending` — предъявителя ещё не спросили, `login` — спросили и никого нет.
 *
 * `impersonation` живёт у родителя и ребёнка целевой семьи, а не отдельным
 * состоянием: под заходом оператор смотрит ровно те экраны, что видит семья,
 * и седьмое состояние означало бы второй набор экранов, отвечающий не на тот
 * вопрос.
 */
export type AppRoute =
  | { kind: 'link'; page: LinkPage }
  | { kind: 'admin' }
  | { kind: 'pending' }
  | { kind: 'login' }
  | { kind: 'agent' }
  | {
    kind: 'parent';
    email: string;
    /** Вторая живая сессия в том же браузере: переход к ученику без пароля. */
    child?: { childId: string; name: string };
    impersonation?: Impersonation;
  }
  | {
    kind: 'child';
    childId: string;
    name: string;
    /** Ученик открыл сводку своего же ребёнка адресом `/parents`. */
    parents: boolean;
    /** Вторая живая сессия: переход к родителю — но уже под пароль. */
    parent?: { email: string };
    impersonation?: Impersonation;
  };

export interface AppRouteInput {
  /**
   * Страница по ссылке. Приходит готовой, а не разбирается из `pathname`:
   * токен уходит из адресной строки сразу после загрузки, и по адресу её потом
   * уже не узнать.
   */
  link: LinkPage | null;
  pathname: string;
  /** Ответ `/api/auth/me`; `null` — ответа ещё нет. */
  principal: AuthState | null;
}

/**
 * Единственное место, где решается, какое состояние рисует корень приложения.
 *
 * Порядок не произволен. Ссылка идёт первой: она гасится один раз, и уступив
 * её живой сессии, приложение потеряло бы приглашение навсегда. Админка — сразу
 * за ней и **до** предъявителя: под заходом `me` возвращает предъявителя чужой
 * семьи, и админка отказывала бы ровно тогда, когда оператор в имперсонации и
 * хочет из неё выйти.
 */
export function appRoute({ link, pathname, principal }: AppRouteInput): AppRoute {
  if (link !== null) return { kind: 'link', page: link };
  if (isAdminPath(pathname)) return { kind: 'admin' };
  if (principal === null) return { kind: 'pending' };
  if (principal.kind === 'anonymous') return { kind: 'login' };
  if (principal.kind === 'agent') return { kind: 'agent' };

  if (principal.kind === 'both') {
    return principal.active === 'parent'
      ? { kind: 'parent', email: principal.parent.email, child: principal.child }
      : {
        kind: 'child',
        childId: principal.child.childId,
        name: principal.child.name,
        parents: pathname === '/parents',
        parent: { email: principal.parent.email },
      };
  }

  const impersonation = principal.impersonation === undefined
    ? {}
    : { impersonation: principal.impersonation };
  return principal.kind === 'parent'
    ? { kind: 'parent', email: principal.email, ...impersonation }
    : {
      kind: 'child',
      childId: principal.childId,
      name: principal.name,
      parents: pathname === '/parents',
      ...impersonation,
    };
}
