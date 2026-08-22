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

/**
 * Закрытый список событий журнала — копия серверного `LOG_EVENTS`
 * (`server/log.ts`): импортировать `server/` клиенту нечем, а без него у
 * фильтра нет ни одного варианта на пустом журнале — то есть отфильтровать
 * можно было бы ровно то, что и так видно.
 *
 * Копия ровно одна на весь клиент, и её синхронность держит
 * `tests/log.test.ts`: разъехавшийся список не роняет ничего — он просто
 * прячет от оператора целый род аварий, и заметить это можно только в тот
 * день, когда авария случилась.
 */
export const ADMIN_LOG_EVENTS = [
  'server-error',
  'tenant-open-failed',
  'tenant-detached',
  'control-error',
  'startup-failed',
  'codex-unavailable',
  'codex-run-failed',
  'sweep-failed',
  'prefetch-failed',
  'backup-failed',
  'login-lockout',
] as const;

export type AdminLogEvent = (typeof ADMIN_LOG_EVENTS)[number];

/** Запись журнала: ровно то, что отдаёт `GET /api/admin/logs`. */
export interface AdminLogEntry {
  at: string;
  event: AdminLogEvent;
  message: string;
  detail?: string;
  childId?: string;
  route?: string;
  status?: number;
}

/** Страница журнала, новые сверху. */
export interface AdminLogPage {
  entries: AdminLogEntry[];
  /** Курсор следующей страницы; его нет, когда отдано всё. */
  nextBefore?: string;
}

export interface AdminLogQuery {
  event?: AdminLogEvent;
  child?: string;
  before?: string;
}

/** Предмет: те же два слова, что и у сервера. */
export type AdminSubject = string;

export interface AdminActiveTime {
  total: number;
  last7Days: number;
  today: number;
}

export interface AdminBossCounts {
  won: number;
  lost: number;
  failed: number;
  live: number;
}

export interface AdminIntegrityCounts {
  reviews: number;
  needsRetry: number;
  retryItems: number;
}

export interface AdminDisputeCounts {
  total: number;
  upheld: number;
  rejected: number;
  open: number;
}

export interface AdminEngagement {
  activeToday: number;
  active7Days: number;
  active30Days: number;
  activeMsTotal: number;
  activeMs7Days: number;
  streaks: { withCurrent: number; longestCurrent: number; longestEver: number };
  churned: number;
  churnByWeek: Array<{ week: number; children: number }>;
}

export interface AdminLearningPicture {
  finishedRuns: number;
  answers: number;
  correct: number;
  /** Доли нет, пока нет ни одного ответа: ноль означал бы «все мимо». */
  accuracy?: number;
  mastery: Array<{ subject: AdminSubject; average: number; topics: number; children: number }>;
  calibrated: Array<{ subject: AdminSubject; children: number }>;
  boss: AdminBossCounts;
  integrity: AdminIntegrityCounts;
  disputes: AdminDisputeCounts & { upheldShare?: number };
}

export interface AdminContentQuality {
  codexCalls: number;
  tasksAdded: number;
  callsPerTask?: number;
  emptyBanks: Array<{ topicId: string; children: number }>;
  worstTopics: Array<{ topicId: string; answers: number; correct: number; accuracy: number }>;
}

/** Строка ребёнка в отчёте слоя 2: список семей на первом экране этих чисел не знает. */
export interface AdminChildStats {
  childId: string;
  schemaVersion: number;
  createdAt: string;
  lastAttemptAt?: string;
  activeMs: AdminActiveTime;
  finishedRuns: number;
  answers: number;
  correct: number;
  streak: { current: number; best: number };
  bank: {
    valid: number;
    pending: number;
    rejected: number;
    used: number;
    reserved: number;
    addedToday: number;
  };
  emptyBankTopics: string[];
}

/** База, до которой обход не добрался: схема не той версии либо файл не открылся. */
export interface AdminSkippedDatabase {
  childId: string;
  schemaVersion: number;
}

/** Слой 2: обход всех детских баз с отметкой времени и признаком неполноты. */
export interface AdminStats {
  generatedAt: string;
  day: string;
  engagement: AdminEngagement;
  learning: AdminLearningPicture;
  content: AdminContentQuality;
  children: AdminChildStats[];
  stale: AdminSkippedDatabase[];
  failed: Array<{ childId: string; reason: string }>;
  skipped: Array<{ childId: string; reason: string }>;
  /** Часть баз не прочитана: числа считаны не по всем детям. */
  partial: boolean;
}

/** Банк и прогресс по одной теме в карточке ребёнка. */
export interface AdminTopicCard {
  topicId: string;
  title?: string;
  subject?: AdminSubject;
  mastery: number;
  attempts: number;
  closedAt?: string;
  bank: { valid: number; pending: number; rejected: number; used: number; reserved: number };
}

export interface AdminMaterialCard {
  id: number;
  topicId: string;
  subject: AdminSubject;
  status: string;
  createdAt: string;
  readyAt?: string;
  openedAt?: string;
  finishedAt?: string;
  tasks: number;
  runs: number;
}

export interface AdminDisputeCard {
  id: number;
  attemptId: number;
  topicId: string;
  status: 'open' | 'upheld' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
}

export interface AdminBossCard {
  id: number;
  topicId: string;
  status: string;
  createdAt: string;
  activatedAt?: string;
  finishedAt?: string;
  tasks: number;
}

/** Состояние дневного доступа: то же, что видит родитель у себя в сводке. */
export interface AdminGateState {
  day: string;
  required: number;
  completed: number;
  remaining: number;
  learning: { materialId: number | null; required: boolean; passed: boolean };
  automaticUnlocked: boolean;
  override: { mode: 'blocked' | 'unlocked'; changedAt: string; expiresAt: string } | null;
  unlocked: boolean;
}

/** Что известно о ребёнке из управляющей базы: оно есть и тогда, когда базы нет. */
export interface AdminChildCard {
  generatedAt: string;
  childId: string;
  parentId: string;
  name: string;
  status: AdminChildStatus;
  createdAt: string;
  lastActivityAt?: string;
  retiredAt?: string;
}

/**
 * Слой 3: карточка одного ребёнка. Три состояния, и сводить их к одному нельзя —
 * «база не читалась» и «в базе пусто» на экране обязаны различаться.
 */
export type AdminChildDetail =
  | (AdminChildCard & {
    state: 'read';
    schemaVersion: number;
    topics: AdminTopicCard[];
    materials: AdminMaterialCard[];
    disputes: AdminDisputeCard[];
    bosses: AdminBossCard[];
    gate: AdminGateState;
  })
  | (AdminChildCard & { state: 'stale'; schemaVersion: number })
  | (AdminChildCard & { state: 'failed'; reason: string });

/** Роль захода в чужую семью: то же слово, что и у сервера. */
export type AdminImpersonationRole = 'browser' | 'parent';

/** Что вернул старт захода. Срок нужен полосе: она называет остаток времени. */
export interface AdminImpersonationStart {
  childId: string;
  role: AdminImpersonationRole;
  expiresAt: string;
}

/**
 * Родитель так, как его отдают изменяющие маршруты админки. Ни отпечатка, ни
 * пароля здесь нет: `hasPassword` говорит, дошёл ли родитель по ссылке до
 * своей формы, — а это и есть весь вопрос оператора о заведённой семье.
 */
export interface AdminParentView {
  parentId: string;
  email: string;
  hasPassword: boolean;
  hasPin: boolean;
  createdAt: string;
  disabledAt?: string;
}

/**
 * Выпущенная ссылка на установку пароля. Сервер отдаёт путь, а не целый адрес:
 * за прокси ему неизвестны ни схема, ни внешнее имя. Целый адрес собирает
 * клиент — он по этому адресу и пришёл.
 */
export interface AdminParentInvite {
  path: string;
  expiresAt: string;
}

export type AdminCourseStatus = 'draft' | 'published' | 'archived';
export type AdminRevisionStatus = 'draft' | 'published';
export type AdminAnswerFormat = 'number' | 'text' | 'choice';

export interface AdminCourse {
  id: string;
  title: string;
  grade: string;
  status: AdminCourseStatus;
  activeRevisionId: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AdminCourseRevision {
  id: number;
  courseId: string;
  revisionNumber: number;
  status: AdminRevisionStatus;
  basedOnRevisionId: number | null;
  editVersion: number;
  title: string;
  grade: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface AdminCourseTopic {
  id: string;
  title: string;
  examWeight: number;
  difficulty: number;
  prereqs: string[];
  answerFormat: AdminAnswerFormat;
  promptSeed: string;
  active: boolean;
  position: number;
  sourceRefs?: AdminTopicSourceRef[];
}

export interface AdminTopicSourceRef {
  sourceId: number;
  pageFrom: number;
  pageTo: number;
}

export interface AdminDraftTopicInput extends Omit<AdminCourseTopic, 'id' | 'position'> {
  id?: string;
  clientId?: string;
}

export interface AdminCourseCard {
  course: AdminCourse;
  revisions: Array<AdminCourseRevision & { topics: AdminCourseTopic[] }>;
}

export interface AdminCourseDraft {
  revision: AdminCourseRevision;
  topics: AdminCourseTopic[];
}

export interface AdminCourseSource {
  id: number;
  courseId: string;
  revisionId: number;
  uploadName: string;
  sha256: string;
  pageCount: number | null;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface AdminSourceProcessingStatus {
  sourceId: number;
  sourceStatus: string;
  job: {
    id: number;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    attempts: number;
    currentPage: number | null;
    error: string | null;
  } | null;
  pages: Array<{ pageNumber: number; status: string; error: string | null }>;
}

export interface AdminCourseBuildStatus {
  revisionId: number;
  job: {
    id: number;
    status: string;
    attempts: number;
    error: string | null;
    updatedAt: string;
  } | null;
}

export interface AdminApi {
  login(email: string, password: string): Promise<{ kind: 'admin'; email: string }>;
  logout(): Promise<void>;
  overview(): Promise<AdminOverview>;
  logs(query?: AdminLogQuery): Promise<AdminLogPage>;
  /** Слой 2. `refresh` заказывает пересчёт: без него отдаётся сохранённый отчёт. */
  stats(refresh?: boolean): Promise<AdminStats>;
  /** Слой 3: карточка названного ребёнка, без кеша — по жалобе смотрят «сейчас». */
  child(childId: string): Promise<AdminChildDetail>;
  /** Зайти в чужую семью. Cookie захода ставится рядом с админской. */
  impersonate(childId: string, role: AdminImpersonationRole): Promise<AdminImpersonationStart>;
  /** Выйти из захода. Оператор остаётся вошедшим: админская cookie не трогается. */
  stopImpersonation(): Promise<void>;
  /** Завести семью: родитель по адресу и одноразовая ссылка ему на пароль. */
  createFamily(email: string): Promise<{ parent: AdminParentView; invite: AdminParentInvite }>;
  /** Ещё одна ссылка на установку пароля уже заведённой семье. */
  issueParentInvite(parentId: string): Promise<{ invite: AdminParentInvite }>;
  /** Пароль, поставленный самим оператором. Отдельное действие в журнале. */
  setParentPassword(parentId: string, password: string): Promise<{ parent: AdminParentView }>;
  courses(): Promise<{ courses: AdminCourse[] }>;
  createCourse(input: { id?: string; title: string; grade: string }): Promise<{
    course: AdminCourse; draft: AdminCourseRevision;
  }>;
  course(courseId: string): Promise<AdminCourseCard>;
  updateCourse(courseId: string, input: {
    revisionId: number; editVersion: number; title: string; grade: string;
  }): Promise<{ course: AdminCourse; revision: AdminCourseRevision }>;
  courseDraft(courseId: string): Promise<AdminCourseDraft>;
  createCourseDraft(courseId: string, activeRevisionId: number): Promise<AdminCourseDraft>;
  replaceCourseTopics(courseId: string, input: {
    revisionId: number; editVersion: number; topics: AdminDraftTopicInput[];
  }): Promise<AdminCourseDraft>;
  publishCourse(courseId: string, input: {
    revisionId: number; editVersion: number; idempotencyKey: string;
  }): Promise<{ revision: AdminCourseRevision; idempotent: boolean }>;
  archiveCourse(courseId: string): Promise<{ course: AdminCourse; idempotent: boolean }>;
  courseSources(courseId: string): Promise<{ sources: AdminCourseSource[] }>;
  uploadCourseSource(courseId: string, file: File): Promise<{
    source: AdminCourseSource; duplicate: boolean;
  }>;
  deleteCourseSource(courseId: string, sourceId: number): Promise<{ source: AdminCourseSource }>;
  courseSourceStatus(courseId: string, sourceId: number): Promise<AdminSourceProcessingStatus>;
  retryCourseSource(courseId: string, sourceId: number, range?: {
    fromPage?: number; toPage?: number;
  }): Promise<{ jobId: number; status: AdminSourceProcessingStatus }>;
  courseBuild(courseId: string): Promise<AdminCourseBuildStatus>;
  buildCourseDraft(courseId: string, input: {
    revisionId: number; editVersion: number;
  }): Promise<{ revisionId: number; status: string }>;
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

/**
 * Адрес страницы журнала. Пустые поля не уезжают вовсе: `child=` сервер читает
 * как «фильтра нет», но пустой `event=` он читает как неизвестное событие и
 * отвечает 400 — то есть снятый фильтр ломал бы ленту.
 */
export function adminLogsUrl(query: AdminLogQuery = {}): string {
  const params = new URLSearchParams();
  if (query.event !== undefined) params.set('event', query.event);
  if (query.child !== undefined && query.child !== '') params.set('child', query.child);
  if (query.before !== undefined && query.before !== '') params.set('before', query.before);
  const search = params.toString();
  return search === '' ? '/api/admin/logs' : `/api/admin/logs?${search}`;
}

/**
 * Адрес отчёта. Пересчёт заказывается ровно значением `1`: сервер сравнивает
 * именно с ним, и `?refresh=0` пересчёта не даст — параметр должен либо быть
 * заказом, либо отсутствовать.
 */
export function adminStatsUrl(refresh = false): string {
  return refresh ? '/api/admin/stats?refresh=1' : '/api/admin/stats';
}

/**
 * Адрес карточки. Идентификатор ребёнка уезжает сегментом пути и потому
 * кодируется: чужой формат сервер отвергает `no-child`, но собрать из него
 * адрес, который спрашивает не про того ребёнка, клиент не должен.
 */
export function adminChildUrl(childId: string): string {
  return `/api/admin/children/${encodeURIComponent(childId)}`;
}

function adminCourseUrl(courseId: string, suffix = ''): string {
  return `/api/admin/courses/${encodeURIComponent(courseId)}${suffix}`;
}

function adminJson<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  return requestJson<T>(url, init, fallback, adminError, ADMIN_POLICY);
}

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
  createFamily: (email) => requestJson<{ parent: AdminParentView; invite: AdminParentInvite }>(
    '/api/admin/parents',
    jsonRequest('POST', { email }),
    'Не получилось завести семью',
    adminError,
    ADMIN_POLICY,
  ),
  issueParentInvite: (parentId) => requestJson<{ invite: AdminParentInvite }>(
    `/api/admin/parents/${encodeURIComponent(parentId)}/invite`,
    jsonRequest('POST'),
    'Не получилось выпустить ссылку',
    adminError,
    ADMIN_POLICY,
  ),
  setParentPassword: (parentId, password) => requestJson<{ parent: AdminParentView }>(
    `/api/admin/parents/${encodeURIComponent(parentId)}/password`,
    jsonRequest('POST', { password }),
    'Не получилось поставить пароль',
    adminError,
    ADMIN_POLICY,
  ),
  impersonate: (childId, role) => requestJson<AdminImpersonationStart>(
    '/api/admin/impersonate',
    jsonRequest('POST', { childId, role }),
    'Не получилось зайти в семью',
    adminError,
    ADMIN_POLICY,
  ),
  stopImpersonation: async () => {
    await requestJson<{ kind: 'admin' }>(
      '/api/admin/impersonate',
      // `DELETE` собирается здесь руками: `jsonRequest` знает только методы с
      // телом, а тела у выхода нет — заход называет cookie, а не запрос.
      { method: 'DELETE' },
      'Не получилось выйти из семьи',
      adminError,
      ADMIN_POLICY,
    );
  },
  stats: (refresh = false) => requestJson<AdminStats>(
    adminStatsUrl(refresh),
    undefined,
    'Не получилось загрузить статистику',
    adminError,
    ADMIN_POLICY,
  ),
  child: (childId) => requestJson<AdminChildDetail>(
    adminChildUrl(childId),
    undefined,
    'Не получилось загрузить карточку ребёнка',
    adminError,
    ADMIN_POLICY,
  ),
  logs: (query = {}) => requestJson<AdminLogPage>(
    adminLogsUrl(query),
    undefined,
    'Не получилось загрузить журнал',
    adminError,
    ADMIN_POLICY,
  ),
  courses: () => adminJson('/api/admin/courses', undefined, 'Не получилось загрузить курсы'),
  createCourse: (input) => adminJson(
    '/api/admin/courses', jsonRequest('POST', input), 'Не получилось создать курс',
  ),
  course: (courseId) => adminJson(adminCourseUrl(courseId), undefined, 'Не получилось загрузить курс'),
  updateCourse: (courseId, input) => adminJson(
    adminCourseUrl(courseId),
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    'Не получилось сохранить метаданные',
  ),
  courseDraft: (courseId) => adminJson(
    adminCourseUrl(courseId, '/draft'), undefined, 'Не получилось загрузить черновик',
  ),
  createCourseDraft: (courseId, activeRevisionId) => adminJson(
    adminCourseUrl(courseId, '/draft'), jsonRequest('POST', { activeRevisionId }),
    'Не получилось создать черновик',
  ),
  replaceCourseTopics: (courseId, input) => adminJson(
    adminCourseUrl(courseId, '/draft/topics'), jsonRequest('PUT', input),
    'Не получилось сохранить темы',
  ),
  publishCourse: (courseId, input) => adminJson(
    adminCourseUrl(courseId, '/publish'), jsonRequest('POST', input), 'Не получилось опубликовать курс',
  ),
  archiveCourse: (courseId) => adminJson(
    adminCourseUrl(courseId, '/archive'), jsonRequest('POST', {}), 'Не получилось архивировать курс',
  ),
  courseSources: (courseId) => adminJson(
    adminCourseUrl(courseId, '/sources'), undefined, 'Не получилось загрузить источники',
  ),
  uploadCourseSource: (courseId, file) => {
    const body = new FormData();
    body.append('file', file);
    return adminJson(
      adminCourseUrl(courseId, '/sources'), { method: 'POST', body }, 'Не получилось загрузить PDF',
    );
  },
  deleteCourseSource: (courseId, sourceId) => adminJson(
    adminCourseUrl(courseId, `/sources/${String(sourceId)}`), { method: 'DELETE' },
    'Не получилось удалить источник',
  ),
  courseSourceStatus: (courseId, sourceId) => adminJson(
    adminCourseUrl(courseId, `/sources/${String(sourceId)}/status`), undefined,
    'Не получилось загрузить состояние OCR',
  ),
  retryCourseSource: (courseId, sourceId, range = {}) => adminJson(
    adminCourseUrl(courseId, `/sources/${String(sourceId)}/retry`), jsonRequest('POST', range),
    'Не получилось повторить OCR',
  ),
  courseBuild: (courseId) => adminJson(
    adminCourseUrl(courseId, '/draft/build'), undefined, 'Не получилось загрузить состояние сборки',
  ),
  buildCourseDraft: (courseId, input) => adminJson(
    adminCourseUrl(courseId, '/draft/build'), jsonRequest('POST', input),
    'Не получилось запустить сборку курса',
  ),
};
