// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserAdminApi } from './admin-api';
import { HttpError, onSignedOut, SignedOutError } from './http';

function response(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('адаптер админского API', () => {
  it('собирает адреса входа, выхода и сводки', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ kind: 'admin', email: 'оператор@example.com' }));
    vi.stubGlobal('fetch', fetch);

    await browserAdminApi.login('оператор@example.com', 'пароль-оператора-подлиннее');
    await browserAdminApi.logout();
    await browserAdminApi.overview();

    expect(fetch.mock.calls).toEqual([
      ['/api/auth/admin/login', expect.objectContaining({
        method: 'POST',
        body: '{"email":"оператор@example.com","password":"пароль-оператора-подлиннее"}',
      })],
      ['/api/auth/admin/logout', { method: 'POST' }],
      ['/api/admin/overview'],
    ]);
  });

  it('собирает адреса захода в чужую семью и выхода из него', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      childId: 'ребёнок-1', role: 'browser', expiresAt: '2026-08-21T09:15:00.000Z',
    }));
    vi.stubGlobal('fetch', fetch);

    await browserAdminApi.impersonate('ребёнок-1', 'browser');
    await browserAdminApi.stopImpersonation();

    expect(fetch.mock.calls).toEqual([
      ['/api/admin/impersonate', expect.objectContaining({
        method: 'POST',
        body: '{"childId":"ребёнок-1","role":"browser"}',
      })],
      // Тела у выхода нет: заход называет cookie, а не запрос.
      ['/api/admin/impersonate', { method: 'DELETE' }],
    ]);
  });

  it('собирает адреса статистики и карточки ребёнка', async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('fetch', fetch);

    await browserAdminApi.stats();
    await browserAdminApi.stats(true);
    await browserAdminApi.child('ребёнок-1');

    expect(fetch.mock.calls).toEqual([
      // Пересчёт заказывается ровно значением `1`: без параметра сервер отдаёт
      // сохранённый отчёт, и `?refresh=0` пересчёта не даст.
      ['/api/admin/stats'],
      ['/api/admin/stats?refresh=1'],
      // Идентификатор уезжает сегментом пути и потому кодируется: собрать из
      // него адрес, который спрашивает не про того ребёнка, клиент не должен.
      ['/api/admin/children/%D1%80%D0%B5%D0%B1%D1%91%D0%BD%D0%BE%D0%BA-1'],
    ]);
  });

  it('собирает адреса заведения семьи, ссылки на смену пароля и самого пароля', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      parent: {
        parentId: 'родитель-1',
        email: 'родитель@example.com',
        hasPassword: false,
        hasPin: false,
        createdAt: '2026-08-21T09:00:00.000Z',
      },
      invite: { path: '/invite/ссылка', expiresAt: '2026-08-28T09:00:00.000Z' },
    }));
    vi.stubGlobal('fetch', fetch);

    await browserAdminApi.createFamily('родитель@example.com');
    await browserAdminApi.issueParentInvite('родитель-1');
    await browserAdminApi.setParentPassword('родитель-1', 'совсем-другой-пароль');

    expect(fetch.mock.calls).toEqual([
      ['/api/admin/parents', expect.objectContaining({
        method: 'POST',
        body: '{"email":"родитель@example.com"}',
      })],
      // Номер родителя уезжает сегментом адреса и обязан быть закодирован: он
      // непрозрачный, и своей кодировки у него нет.
      ['/api/admin/parents/%D1%80%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C-1/invite', expect.objectContaining({
        method: 'POST',
      })],
      ['/api/admin/parents/%D1%80%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C-1/password', expect.objectContaining({
        method: 'POST',
        body: '{"password":"совсем-другой-пароль"}',
      })],
    ]);
  });

  it('отдаёт 401 своим кодом и не трогает общий переход ко входу семьи', async () => {
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Нужно войти' }, { ok: false, status: 401 }),
    ));

    // Слушатель `onSignedOut` рисует родительский вход: отданная ему
    // кончившаяся сессия оператора уводила бы его с админки не туда.
    const failed = await browserAdminApi.overview().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HttpError);
    expect(failed).not.toBeInstanceOf(SignedOutError);
    expect(failed).toMatchObject({ status: 401, message: 'Нужно войти' });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('называет отказ входа текстом сервера, а недоступность — своим кодом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Сводка недоступна: нет управляющей базы' }, { ok: false, status: 503 }),
    ));

    await expect(browserAdminApi.overview()).rejects.toMatchObject({
      status: 503,
      message: 'Сводка недоступна: нет управляющей базы',
    });
  });

  it('собирает JSON, multipart и status-запросы каталога курсов', async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('fetch', fetch);
    const file = new File(['%PDF-1.7'], 'учебник.pdf', { type: 'application/pdf' });

    await browserAdminApi.createCourse({ id: 'history-6', title: 'История', grade: '6 класс' });
    await browserAdminApi.updateCourse('history/6', {
      revisionId: 2, editVersion: 3, title: 'История мира', grade: '6 класс',
    });
    await browserAdminApi.uploadCourseSource('history/6', file);
    await browserAdminApi.courseSourceStatus('history/6', 9);
    await browserAdminApi.retryCourseSource('history/6', 9, { fromPage: 2, toPage: 4 });
    await browserAdminApi.deleteCourseSource('history/6', 9);

    expect(fetch.mock.calls[0]).toEqual(['/api/admin/courses', expect.objectContaining({
      method: 'POST', body: '{"id":"history-6","title":"История","grade":"6 класс"}',
    })]);
    expect(fetch.mock.calls[1]).toEqual(['/api/admin/courses/history%2F6', expect.objectContaining({ method: 'PATCH' })]);
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/admin/courses/history%2F6/sources');
    expect((fetch.mock.calls[2]?.[1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(fetch.mock.calls.slice(3)).toEqual([
      ['/api/admin/courses/history%2F6/sources/9/status'],
      ['/api/admin/courses/history%2F6/sources/9/retry', expect.objectContaining({
        method: 'POST', body: '{"fromPage":2,"toPage":4}',
      })],
      ['/api/admin/courses/history%2F6/sources/9', { method: 'DELETE' }],
    ]);
  });
});
