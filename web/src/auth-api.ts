import { HttpError, jsonRequest, requestJson, type HttpFailure } from './http';

/**
 * Кто сейчас за браузером. `anonymous` — обычное состояние страницы входа, а
 * не ошибка: сервер отвечает на `me` двухсоткой и в этом случае тоже.
 */
export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'parent'; email: string }
  | { kind: 'child'; childId: string; name: string }
  | { kind: 'agent'; childId: string };

export type AuthState = Principal | {
  kind: 'both';
  active: 'parent' | 'child';
  parent: { email: string };
  child: { childId: string; name: string };
};

/** Что вернуло погашение детской ссылки: браузер получает cookie, агент — токен. */
export type DeviceClaim =
  | { kind: 'child'; childId: string }
  | { kind: 'agent'; childId: string; token: string };

export interface AuthApi {
  me(): Promise<AuthState>;
  login(email: string, password: string): Promise<Principal>;
  logout(): Promise<void>;
  /** Чтение приглашения родителя не гасит его: адрес нужен форме пароля. */
  readInvite(token: string): Promise<{ email: string }>;
  redeemInvite(token: string, password: string): Promise<Principal>;
  claimDevice(token: string): Promise<DeviceClaim>;
  switchPersona(kind: 'child'): Promise<AuthState>;
  switchPersona(kind: 'parent', password: string): Promise<AuthState>;
}

/**
 * У входа и у ссылок 401 и 404 значат «секрет не подошёл», а не «сессия
 * кончилась»: поэтому все они идут с выключенным общим переходом ко входу —
 * иначе форма входа перерисовывалась бы на каждой неудачной попытке, теряя
 * набранный адрес и объяснение отказа.
 */
const KEEP_SCREEN: { signedOutOn401: boolean } = { signedOutOn401: false };

/** Отказ ссылки едет с кодом: 404 значит «погашена», всё прочее — «не доехало». */
const linkError = (failure: HttpFailure): Error => new HttpError(failure);

export const browserAuthApi: AuthApi = {
  me: () => requestJson<AuthState>('/api/auth/me', undefined, 'Не получилось проверить вход'),
  login: (email, password) => requestJson<Principal>(
    '/api/auth/parent/login',
    jsonRequest('POST', { email, password }),
    'Не получилось войти',
    undefined,
    KEEP_SCREEN,
  ),
  logout: async () => {
    await requestJson<{ kind: 'anonymous' }>(
      '/api/auth/parent/logout',
      jsonRequest('POST'),
      'Не получилось выйти',
      undefined,
      KEEP_SCREEN,
    );
  },
  readInvite: (token) => requestJson<{ email: string }>(
    `/api/auth/parent/invite/${encodeURIComponent(token)}`,
    undefined,
    'Ссылка недействительна или уже использована',
    linkError,
    KEEP_SCREEN,
  ),
  redeemInvite: (token, password) => requestJson<Principal>(
    `/api/auth/parent/invite/${encodeURIComponent(token)}`,
    jsonRequest('POST', { password }),
    'Ссылка недействительна или уже использована',
    linkError,
    KEEP_SCREEN,
  ),
  claimDevice: (token) => requestJson<DeviceClaim>(
    `/api/auth/child/claim/${encodeURIComponent(token)}`,
    jsonRequest('POST'),
    'Ссылка недействительна или уже использована',
    linkError,
    KEEP_SCREEN,
  ),
  switchPersona: (kind, password?: string) => requestJson<AuthState>(
    '/api/auth/persona',
    jsonRequest('POST', kind === 'parent' ? { kind, password } : { kind }),
    'Не получилось переключить пользователя',
    undefined,
    KEEP_SCREEN,
  ),
};
