import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminClient } from '../scripts/admin-client.js';

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
});
