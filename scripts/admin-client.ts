/**
 * HTTP-клиент админского API каталога. Единственная дверь, которой импортный
 * скрипт вообще может достучаться до `control.db`: сам каталог данных держит
 * замок сервера (`server/index.ts`), и второй держатель замка при живом
 * сервере невозможен — так устроены `prefetch` и `adopt`. Поэтому импорт ходит
 * тем же путём, что и браузер оператора: входом, cookie, `Origin`.
 *
 * Модуль знает только форму запросов и ответов настоящих маршрутов
 * (`server/routes/admin/auth.ts`, `server/routes/admin/courses.ts`). Знания о
 * манифесте, нарезке ФРП или правилах отбраковки здесь нет и быть не должно —
 * они живут в оркестраторе задачи 7.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CatalogRevisionTopic } from '../server/course-catalog.js';
import type { SourceProcessingStatus } from '../server/catalog-worker.js';

/** Имя cookie сессии оператора — то же, что `ADMIN_COOKIE` в `server/auth.ts`. */
const ADMIN_COOKIE_NAME = '__Host-edu_admin';

export interface AdminClient {
  login(email: string, password: string): Promise<void>;
  listCourses(): Promise<Array<{ id: string; title: string; grade: string; activeRevisionId: number | null }>>;
  createCourse(input: { id?: string; title: string; grade: string }): Promise<{ course: { id: string }; draft: { id: number; editVersion: number } }>;
  readDraft(courseId: string): Promise<{ revision: { id: number; editVersion: number }; topics: CatalogRevisionTopic[] } | undefined>;
  createDraft(courseId: string, activeRevisionId: number): Promise<{ revision: { id: number; editVersion: number } }>;
  uploadSource(courseId: string, filePath: string): Promise<{ source: { id: number; revisionId: number }; duplicate: boolean }>;
  /**
   * Настоящая форма ответа маршрута (`server/catalog-worker.ts`), без
   * перевода: `job.error` называет причину отказа OCR, и укороченный
   * клиентский словарь с полем `status` вместо `sourceStatus` эту причину
   * бы стёр — оркестратор задачи 7 обязан уметь сказать, почему источник
   * готовым не стал, а не только «не дождались».
   */
  sourceStatus(courseId: string, sourceId: number): Promise<SourceProcessingStatus>;
  startBuild(courseId: string, revisionId: number, editVersion: number): Promise<void>;
  buildStatus(courseId: string): Promise<{ revisionId: number; job: { status: string; error: string | null } | null }>;
  publish(courseId: string, revisionId: number, editVersion: number, idempotencyKey: string): Promise<{ idempotent?: boolean }>;
}

type JsonBody = Record<string, unknown>;

async function readJsonBody(response: Response): Promise<JsonBody> {
  const text = await response.text();
  if (text === '') return {};
  return JSON.parse(text) as JsonBody;
}

function errorFrom(data: JsonBody, fallback: string): Error {
  const message = typeof data['error'] === 'string' ? data['error'] : fallback;
  return new Error(message);
}

export function createAdminClient(baseUrl: string, fetchImpl: typeof fetch = fetch): AdminClient {
  // Хвостовой слэш не влияет на настоящий вход, но ломает сравнение конкатенацией.
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  let cookie: string | undefined;

  /**
   * Единственное место, где собирается запрос. `Origin` ставится на **каждый**
   * запрос, не только изменяющий: изменяющие запросы сверяют источник целиком,
   * схему вместе с хостом, и без `Origin` каждый POST вернёт 403 — браузерных
   * заголовков у скрипта нет, и подставить их больше некому.
   */
  async function send(method: string, path: string, body?: JsonBody | FormData): Promise<Response> {
    const headers = new Headers();
    headers.set('origin', origin);
    if (cookie !== undefined) headers.set('cookie', cookie);
    // `BodyInit` не входит в глобальные типы `@types/node` (объявлен только
    // внутри `undici-types`), поэтому сужаем до двух видов тела, которые
    // клиент реально отправляет.
    let payload: string | FormData | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }
    return fetchImpl(`${origin}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
  }

  /** Обычный вызов: ненулевой статус превращает в ошибку с текстом из тела. */
  async function call(method: string, path: string, body?: JsonBody | FormData): Promise<JsonBody> {
    const response = await send(method, path, body);
    const data = await readJsonBody(response);
    if (!response.ok) throw errorFrom(data, `${method} ${path}: код ответа ${String(response.status)}`);
    return data;
  }

  /** Как `call`, но 404 — состояние («у курса нет черновика»), а не поломка. */
  async function callOptional(method: string, path: string): Promise<JsonBody | undefined> {
    const response = await send(method, path);
    const data = await readJsonBody(response);
    if (response.status === 404) return undefined;
    if (!response.ok) throw errorFrom(data, `${method} ${path}: код ответа ${String(response.status)}`);
    return data;
  }

  return {
    async login(email, password) {
      const response = await send('POST', '/api/auth/admin/login', { email, password });
      const data = await readJsonBody(response);
      if (!response.ok) throw errorFrom(data, `вход отклонён: код ответа ${String(response.status)}`);
      // Вход, не получивший cookie, обязан быть отказом, а не молчаливым
      // успехом: иначе первая же настоящая операция упрётся в 401, а причиной
      // будет назван не вход.
      const setCookie = response.headers.get('set-cookie');
      const found = setCookie === null
        ? undefined
        : new RegExp(`${ADMIN_COOKIE_NAME}=[^;]+`, 'u').exec(setCookie)?.[0];
      if (found === undefined) {
        throw new Error(`Вход не выдал cookie ${ADMIN_COOKIE_NAME}: сервер не подтвердил сессию`);
      }
      cookie = found;
    },

    async listCourses() {
      const data = await call('GET', '/api/admin/courses');
      return data['courses'] as Array<{ id: string; title: string; grade: string; activeRevisionId: number | null }>;
    },

    async createCourse(input) {
      const data = await call('POST', '/api/admin/courses', { ...input });
      return data as unknown as { course: { id: string }; draft: { id: number; editVersion: number } };
    },

    async readDraft(courseId) {
      const data = await callOptional('GET', `/api/admin/courses/${encodeURIComponent(courseId)}/draft`);
      if (data === undefined) return undefined;
      return data as unknown as { revision: { id: number; editVersion: number }; topics: CatalogRevisionTopic[] };
    },

    async createDraft(courseId, activeRevisionId) {
      const data = await call('POST', `/api/admin/courses/${encodeURIComponent(courseId)}/draft`, { activeRevisionId });
      return data as unknown as { revision: { id: number; editVersion: number } };
    },

    async uploadSource(courseId, filePath) {
      const content = await readFile(filePath);
      const form = new FormData();
      // Поле называется `source` вслед за настоящим маршрутом
      // (`server/routes/admin/courses.ts` читает `request.file()` из
      // multipart с одной частью — но имя поля видно только в тестах маршрута,
      // `tests/admin-course-sources-routes.test.ts`, и совпадение с ним не
      // случайно).
      form.append('source', new Blob([content], { type: 'application/pdf' }), basename(filePath));
      const data = await call('POST', `/api/admin/courses/${encodeURIComponent(courseId)}/sources`, form);
      return data as unknown as { source: { id: number; revisionId: number }; duplicate: boolean };
    },

    async sourceStatus(courseId, sourceId) {
      // Без перевода: `SourceProcessingStatus` уже объявлен сервером, и
      // повторный словарь с другими именами полей разъехался бы с ним молча
      // (то самое предупреждение CLAUDE.md про укороченную копию типа).
      const data = await call(
        'GET',
        `/api/admin/courses/${encodeURIComponent(courseId)}/sources/${String(sourceId)}/status`,
      );
      return data as unknown as SourceProcessingStatus;
    },

    async startBuild(courseId, revisionId, editVersion) {
      await call('POST', `/api/admin/courses/${encodeURIComponent(courseId)}/draft/build`, { revisionId, editVersion });
    },

    async buildStatus(courseId) {
      const data = await call('GET', `/api/admin/courses/${encodeURIComponent(courseId)}/draft/build`);
      return data as unknown as { revisionId: number; job: { status: string; error: string | null } | null };
    },

    async publish(courseId, revisionId, editVersion, idempotencyKey) {
      const data = await call('POST', `/api/admin/courses/${encodeURIComponent(courseId)}/publish`, {
        revisionId, editVersion, idempotencyKey,
      });
      return data as unknown as { idempotent?: boolean };
    },
  };
}
