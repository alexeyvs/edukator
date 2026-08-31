import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminClient, NETWORK_RETRIES, NETWORK_RETRY_DELAY_MS } from '../scripts/admin-client.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as unknown as typeof fetch;
}

const loggedIn = new Response('{}', {
  status: 200, headers: { 'set-cookie': '__Host-edu_admin=abc123tok; Path=/' },
});

describe('createAdminClient', () => {
  it('шлёт Origin на изменяющем запросе: браузерных заголовков у скрипта нет', async () => {
    let seen: string | undefined;
    const client = createAdminClient('https://edukator.ru', fakeFetch((_url, init) => {
      seen = new Headers(init.headers).get('origin') ?? undefined;
      return loggedIn.clone();
    }));
    await client.login('оператор@пример.рф', 'пароль-подлиннее-и-ещё');
    expect(seen).toBe('https://edukator.ru');
  });

  it('несёт cookie входа в следующий запрос', async () => {
    let cookie: string | undefined;
    const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
      if (url.endsWith('/api/auth/admin/login')) return loggedIn.clone();
      cookie = new Headers(init.headers).get('cookie') ?? undefined;
      return new Response(JSON.stringify({ courses: [] }), { status: 200 });
    }));
    await client.login('оператор@пример.рф', 'пароль-подлиннее-и-ещё');
    await client.listCourses();
    expect(cookie).toContain('__Host-edu_admin=abc123tok');
  });

  it('вход без Set-Cookie — отказ, а не молчаливый успех', async () => {
    const client = createAdminClient('https://edukator.ru',
      fakeFetch(() => new Response('{}', { status: 200 })));
    await expect(client.login('оператор@пример.рф', 'пароль')).rejects.toThrow(/cookie/u);
  });

  it('403 называет причину из тела, а не «не удалось»', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ error: 'read-only' }), { status: 403 })));
    await client.login('оператор@пример.рф', 'пароль');
    await expect(client.listCourses()).rejects.toThrow(/read-only/u);
  });

  it('publish отвечает idempotent на уже опубликованной редакции', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ revision: { id: 3 }, idempotent: true }), { status: 200 })));
    await client.login('оператор@пример.рф', 'пароль');
    expect((await client.publish('math', 3, 1, 'ключ')).idempotent).toBe(true);
  });

  it('readDraft на курсе без черновика возвращает undefined, а не бросает', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ error: 'нет черновика' }), { status: 404 })));
    await client.login('оператор@пример.рф', 'пароль');
    expect(await client.readDraft('math')).toBeUndefined();
  });

  it('readCourse отдаёт темы опубликованной редакции, а не только черновика', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({
          course: { id: 'math', title: 'Математика', grade: '7 класс', activeRevisionId: 4 },
          revisions: [
            { id: 4, status: 'published', topics: [{ id: 'math.fractions' }, { id: 'math.angles' }] },
            { id: 8, status: 'draft', topics: [] },
          ],
        }), { status: 200 })));
    await client.login('оператор@пример.рф', 'пароль');
    const card = await client.readCourse('math');
    // Именно эти идентификаторы и есть накопленный прогресс детей: `readDraft`
    // их уже не покажет, если черновик собран заново.
    expect(card?.revisions.find((revision) => revision.id === 4)?.topics.map((topic) => topic.id))
      .toEqual(['math.fractions', 'math.angles']);
  });

  it('readCourse на несуществующем курсе возвращает undefined, а не бросает', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
      url.endsWith('/login') ? loggedIn.clone()
        : new Response(JSON.stringify({ error: 'Курс не найден' }), { status: 404 })));
    await client.login('оператор@пример.рф', 'пароль');
    expect(await client.readCourse('geo-5')).toBeUndefined();
  });

  it('retrySource шлёт объект тела: пустое маршрут отвергает', async () => {
    let seen: { url?: string; body?: unknown } = {};
    const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
      if (url.endsWith('/login')) return loggedIn.clone();
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ jobId: 12 }), { status: 200 });
    }));
    await client.login('оператор@пример.рф', 'пароль');
    await client.retrySource('geo-5', 5);
    expect(seen.url).toBe('https://edukator.ru/api/admin/courses/geo-5/sources/5/retry');
    expect(seen.body).toEqual({});
  });

  it('createCourse и createDraft называют сервером назначенные номера редакций', async () => {
    const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
      if (url.endsWith('/login')) return loggedIn.clone();
      if (url.endsWith('/api/admin/courses')) {
        return new Response(JSON.stringify({
          course: { id: 'geo-5' }, draft: { id: 1, editVersion: 1 },
        }), { status: 201 });
      }
      // Черновик заводится от **названной** активной редакции: сервер сверяет
      // её номер и отказывает, если редакцию сменили между чтением и запросом.
      expect(JSON.parse(String(init.body))).toEqual({ activeRevisionId: 7 });
      return new Response(JSON.stringify({ revision: { id: 8, editVersion: 1 } }), { status: 201 });
    }));
    await client.login('оператор@пример.рф', 'пароль');
    expect(await client.createCourse({ title: 'География', grade: '5 класс' }))
      .toEqual({ course: { id: 'geo-5' }, draft: { id: 1, editVersion: 1 } });
    expect((await client.createDraft('geo-5', 7)).revision.id).toBe(8);
  });

  it('startBuild шлёт версию черновика, buildStatus отдаёт состояние задания', async () => {
    let started: unknown;
    const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
      if (url.endsWith('/login')) return loggedIn.clone();
      if (init.method === 'POST') {
        started = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ revisionId: 8, status: 'running' }), { status: 202 });
      }
      return new Response(JSON.stringify({
        revisionId: 8, job: { status: 'failed', error: 'модель не ответила' },
      }), { status: 200 });
    }));
    await client.login('оператор@пример.рф', 'пароль');
    await client.startBuild('geo-5', 8, 3);
    // Версия обязана уехать на сервер: без неё оптимистичная блокировка
    // черновика не сработает вовсе.
    expect(started).toEqual({ revisionId: 8, editVersion: 3 });
    expect((await client.buildStatus('geo-5')).job?.error).toBe('модель не ответила');
  });

  describe('источники: настоящая форма ответа сервера', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'edukator-admin-client-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('uploadSource шлёт PDF как FormData с полем source', async () => {
      const filePath = join(dir, 'programme.pdf');
      writeFileSync(filePath, Buffer.from('%PDF-1.7\nтест\n%%EOF\n'));
      let seenBody: FormData | undefined;
      const client = createAdminClient('https://edukator.ru', fakeFetch((url, init) => {
        if (url.endsWith('/login')) return loggedIn.clone();
        // Заголовок `content-type` с boundary расставляет сам рантайм `fetch`
        // при сериализации `FormData`-тела — здесь его нет, потому что
        // подменённый `fetch` тело не сериализует. Проверяем то, что
        // действительно собирает клиент: сам объект `FormData` и его поле.
        seenBody = init.body as FormData;
        return new Response(
          JSON.stringify({ source: { id: 5, revisionId: 2 }, duplicate: false }),
          { status: 201 },
        );
      }));
      await client.login('оператор@пример.рф', 'пароль');
      const uploaded = await client.uploadSource('geo-5', filePath);
      expect(uploaded).toEqual({ source: { id: 5, revisionId: 2 }, duplicate: false });
      expect(seenBody).toBeInstanceOf(FormData);
      const file = seenBody?.get('source');
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).type).toBe('application/pdf');
    });

    it('listSources отдаёт отпечаток и номер редакции каждого источника', async () => {
      let seenUrl: string | undefined;
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) => {
        if (url.endsWith('/login')) return loggedIn.clone();
        seenUrl = url;
        return new Response(JSON.stringify({
          sources: [{
            id: 5, courseId: 'geo-5', revisionId: 7, uploadName: 'programme.pdf',
            sha256: 'a'.repeat(64), pageCount: 12, status: 'ready', error: null,
            createdAt: '2026-08-30T00:00:00.000Z',
          }],
        }), { status: 200 });
      }));
      await client.login('оператор@пример.рф', 'пароль');
      const sources = await client.listSources('geo-5');
      expect(seenUrl).toBe('https://edukator.ru/api/admin/courses/geo-5/sources');
      // Обе колонки, на которых держится пропуск уже импортированного курса:
      // отпечаток куска и номер редакции, которой он принадлежит.
      expect(sources[0]?.sha256).toBe('a'.repeat(64));
      expect(sources[0]?.revisionId).toBe(7);
    });

    it('sourceStatus отдаёт настоящую форму маршрута целиком, включая причину отказа OCR', async () => {
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) =>
        url.endsWith('/login') ? loggedIn.clone()
          : new Response(JSON.stringify({
            sourceId: 5,
            sourceStatus: 'failed',
            job: { id: 9, status: 'failed', attempts: 1, currentPage: 3, error: 'скан страницы 3 нечитаем' },
            pages: [
              { pageNumber: 1, status: 'succeeded', error: null },
              { pageNumber: 2, status: 'succeeded', error: null },
              { pageNumber: 3, status: 'failed', error: 'скан страницы 3 нечитаем' },
            ],
          }), { status: 200 })));
      await client.login('оператор@пример.рф', 'пароль');
      const status = await client.sourceStatus('geo-5', 5);
      // Перевод в укороченный словарь (`status`/число `pages`) стёр бы ровно
      // это поле — причину, по которой источник не стал готовым.
      expect(status.job?.error).toBe('скан страницы 3 нечитаем');
      expect(status.sourceStatus).toBe('failed');
      expect(status.pages).toHaveLength(3);
    });
  });

  // Импорт шестидесяти курсов идёт часами, а сессия оператора живёт 8 часов и
  // гаснет после 30 минут простоя. Первый боевой прогон потерял на этом 13
  // курсов: клиент входил один раз в начале, и с какого-то момента каждый
  // запрос получал «Нужно войти».
  describe('живучесть сессии и связи', () => {
    const okLogin = (n: number): Response => new Response('{}', {
      status: 200,
      headers: { 'set-cookie': `__Host-edu_admin=t${String(n)}; Path=/` },
    });

    it('истёкшая сессия переоткрывается, и запрос повторяется', async () => {
      let logins = 0;
      let asked = 0;
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) => {
        if (url.endsWith('/api/auth/admin/login')) return okLogin((logins += 1));
        asked += 1;
        return asked === 1
          ? new Response(JSON.stringify({ error: 'Нужно войти' }), { status: 401 })
          : new Response(JSON.stringify({ courses: [] }), { status: 200 });
      }), { retryDelayMs: 1 });
      await client.login('оператор@пример.рф', 'пароль');

      await expect(client.listCourses()).resolves.toEqual([]);
      expect(logins).toBe(2);
    });

    it('повторный вход не зацикливается: второй отказ доносится', async () => {
      let logins = 0;
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) => {
        if (url.endsWith('/api/auth/admin/login')) return okLogin((logins += 1));
        return new Response(JSON.stringify({ error: 'Нужно войти' }), { status: 401 });
      }), { retryDelayMs: 1 });
      await client.login('оператор@пример.рф', 'пароль');

      await expect(client.listCourses()).rejects.toThrow(/Нужно войти/u);
      expect(logins).toBe(2);
    });

    it('сетевой обрыв повторяется, а не уносит курс в отказ', async () => {
      let attempts = 0;
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) => {
        if (url.endsWith('/api/auth/admin/login')) return okLogin(1);
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ courses: [] }), { status: 200 });
      }), { retryDelayMs: 1 });
      await client.login('оператор@пример.рф', 'пароль');

      await expect(client.listCourses()).resolves.toEqual([]);
      expect(attempts).toBe(2);
    });

    it('держит калибровочные константы повторов', () => {
      expect(NETWORK_RETRIES).toBe(3);
      expect(NETWORK_RETRY_DELAY_MS).toBe(2_000);
    });

    it('обрыв, переживший все повторы, доносится', async () => {
      const client = createAdminClient('https://edukator.ru', fakeFetch((url) => {
        if (url.endsWith('/api/auth/admin/login')) return okLogin(1);
        throw new TypeError('fetch failed');
      }), { retryDelayMs: 1 });
      await client.login('оператор@пример.рф', 'пароль');

      await expect(client.listCourses()).rejects.toThrow(/fetch failed/u);
    });
  });
});
