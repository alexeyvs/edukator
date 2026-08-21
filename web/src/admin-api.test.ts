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
});
