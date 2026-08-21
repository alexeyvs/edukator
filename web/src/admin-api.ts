import { HttpError, jsonRequest, requestJson, type HttpFailure } from './http';

/** Состояние ребёнка в списке семей: то же слово, что и у сервера. */
export type AdminChildStatus = 'provisioning' | 'ready' | 'failed';

export interface AdminFamilyChild {
  childId: string;
  name: string;
  status: AdminChildStatus;
  lastActivityAt?: string;
  retiredAt?: string;
  createdAt: string;
}

export interface AdminFamily {
  parentId: string;
  email: string;
  disabledAt?: string;
  createdAt: string;
  children: AdminFamilyChild[];
}

export interface AdminCreatedCounts {
  total: number;
  last7Days: number;
  last30Days: number;
}

export interface AdminParentsOverview extends AdminCreatedCounts {
  disabled: number;
}

export interface AdminChildrenOverview extends AdminCreatedCounts {
  ready: number;
  provisioning: number;
  failed: number;
  retired: number;
}

export interface AdminStuckChild {
  childId: string;
  parentId: string;
  name: string;
  status: Exclude<AdminChildStatus, 'ready'>;
  createdAt: string;
}

export interface AdminQuotaOverview {
  day: string;
  limit: number;
  used: number;
  children: Array<{ childId: string; used: number }>;
}

export interface AdminLockout {
  scope: 'email' | 'address';
  kind: 'password' | 'pin' | 'admin';
  key: string;
  failures: number;
  lastFailedAt: string;
  /** Сколько паузы осталось. Всегда больше нуля: остывшие строки сюда не попадают. */
  retryAfterMs: number;
}

export interface AdminDatabaseSize {
  childId: string;
  bytes: number;
  /** `false` — файла базы нет вовсе: у застрявшего заведения так и должно быть. */
  present: boolean;
}

export interface AdminStorageOverview {
  controlBytes: number;
  childrenBytes: number;
  totalBytes: number;
  freeBytes?: number;
  children: AdminDatabaseSize[];
}

/** Слой 1: всё, что видно из одной управляющей базы. */
export interface AdminOverview {
  generatedAt: string;
  families: AdminFamily[];
  parents: AdminParentsOverview;
  children: AdminChildrenOverview;
  stuck: AdminStuckChild[];
  quota: AdminQuotaOverview;
  sessions: { parents: number; admins: number };
  devices: { browser: number; agent: number; pendingInvites: number };
  lockouts: AdminLockout[];
  storage: AdminStorageOverview;
}

export interface AdminApi {
  login(email: string, password: string): Promise<{ kind: 'admin'; email: string }>;
  logout(): Promise<void>;
  overview(): Promise<AdminOverview>;
}

/**
 * Все запросы админки идут мимо общего перехода ко входу.
 *
 * Общий слушатель `onSignedOut` говорит про сессию **семьи**: он рисует форму
 * родительского входа и объясняет ученику, что его устройство отключили.
 * Кончившаяся сессия оператора — другое событие с тем же кодом 401, и, отданная
 * тому слушателю, она уводила бы оператора со своего экрана на родительский
 * вход. Поэтому 401 приезжает сюда обычным `HttpError` со статусом, а решение
 * «показать форму оператора» принимает корень админки.
 */
const ADMIN_POLICY: { signedOutOn401: boolean } = { signedOutOn401: false };

/** Отказ едет со статусом: 401 значит «войдите заново», прочее — «не доехало». */
const adminError = (failure: HttpFailure): Error => new HttpError(failure);

export const browserAdminApi: AdminApi = {
  login: (email, password) => requestJson<{ kind: 'admin'; email: string }>(
    '/api/auth/admin/login',
    jsonRequest('POST', { email, password }),
    'Не получилось войти',
    adminError,
    ADMIN_POLICY,
  ),
  logout: async () => {
    await requestJson<{ kind: 'anonymous' }>(
      '/api/auth/admin/logout',
      jsonRequest('POST'),
      'Не получилось выйти',
      adminError,
      ADMIN_POLICY,
    );
  },
  overview: () => requestJson<AdminOverview>(
    '/api/admin/overview',
    undefined,
    'Не получилось загрузить сводку',
    adminError,
    ADMIN_POLICY,
  ),
};
