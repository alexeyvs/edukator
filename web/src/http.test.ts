// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, onReadOnly, onSignedOut, ReadOnlyError, requestJson, SignedOutError } from './http';

function response(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('общий разбор ответа', () => {
  it('переводит 401 в отдельный отказ и сообщает о потере сессии', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Нужно войти' }, { ok: false, status: 401 }),
    ));
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);

    const failure = await requestJson('/api/parents/c-1', undefined, 'Не получилось загрузить сводку')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignedOutError);
    expect((failure as Error).message).toBe('Нужно войти');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('не подставляет fallback вместо 401: «не получилось загрузить» — не про вход', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { ok: false, status: 401 })));

    const failure = await requestJson('/api/family', undefined, 'Не получилось загрузить семью')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignedOutError);
    expect((failure as Error).message).toBe('Нужно войти');
  });

  it('оставляет 401 обычным отказом там, где он значит «не тот секрет»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Неверный PIN родителя' }, { ok: false, status: 401 }),
    ));
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);

    const failure = await requestJson(
      '/api/parents/c-1/computer-access',
      { method: 'PUT' },
      'Не получилось изменить режим доступа',
      undefined,
      { signedOutOn401: false },
    ).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(SignedOutError);
    expect((failure as Error).message).toBe('Неверный PIN родителя');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('всё равно выкидывает на вход, когда 401 назван сервером «unauthenticated»', async () => {
    // Детское устройство предъявляет PIN всегда, так что `signedOutOn401: false`
    // стоит и на погашенной cookie. Без разбора кода сервера кончившаяся сессия
    // рисовалась бы красной строкой «неверный PIN» под кнопками, а экран
    // навсегда оставался бы на устаревшей сводке — объясняя это опечаткой.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Нужно войти', code: 'unauthenticated' }, { ok: false, status: 401 }),
    ));
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);

    const failure = await requestJson(
      '/api/parents/c-1/computer-access',
      { method: 'PUT' },
      'Не получилось изменить режим доступа',
      undefined,
      { signedOutOn401: false, signedOutOnUnauthenticated: true },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignedOutError);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('не трогает остальные коды и оставляет им фабрику ошибки и fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { ok: false, status: 503 })));
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);

    const failure = await requestJson(
      '/api/family',
      undefined,
      'Не получилось загрузить семью',
      ({ status, message }) => new Error(`${String(status)}: ${message}`),
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toBe('503: Не получилось загрузить семью');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('разбирает 401 с не-JSON телом: за прокси отказ приходит страницей', async () => {
    // Обратный прокси отвечает 401 страницей HTML. Разбор тела до проверки
    // `ok` бросал бы на ней `SyntaxError` раньше, чем дошёл бы до
    // `SignedOutError`, — и кончившаяся сессия показывала бы «не удалось
    // загрузить» вместо экрана входа именно там, где прокси и стоит.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
    }));
    const listener = vi.fn();
    const unsubscribe = onSignedOut(listener);

    const failure = await requestJson('/api/family', undefined, 'Не получилось загрузить семью')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignedOutError);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('переводит отказ «только просмотр» в отдельный отказ и объявляет его', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response(
        { error: 'Только просмотр: вы в чужой семье', code: 'read-only' },
        { ok: false, status: 403 },
      ),
    ));
    const listener = vi.fn();
    const unsubscribe = onReadOnly(listener);

    const failure = await requestJson(
      '/api/session/answer',
      { method: 'POST' },
      'Не получилось отправить ответ',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReadOnlyError);
    expect((failure as Error).message).toBe('Только просмотр: вы в чужой семье');
    expect(listener).toHaveBeenCalledWith('Только просмотр: вы в чужой семье');
    unsubscribe();
  });

  it('различает «только просмотр» и прочие 403: у них один статус и разный смысл', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Доступ закрыт', code: 'forbidden' }, { ok: false, status: 403 }),
    ));
    const listener = vi.fn();
    const unsubscribe = onReadOnly(listener);

    const failure = await requestJson(
      '/api/profile',
      { method: 'PUT' },
      'Не получилось сохранить профиль',
      (info) => new HttpError(info),
    ).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(ReadOnlyError);
    expect((failure as HttpError).code).toBe('forbidden');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('отписка снимает и слушателя отказа «только просмотр»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ code: 'read-only' }, { ok: false, status: 403 }),
    ));
    const listener = vi.fn();
    onReadOnly(listener)();

    const failure = await requestJson('/api/profile', { method: 'PUT' }, 'Не получилось сохранить профиль')
      .catch((error: unknown) => error);

    // Тела сервер мог и не прислать: текст тогда свой, но отказ — тот же самый.
    expect(failure).toBeInstanceOf(ReadOnlyError);
    expect((failure as Error).message).toBe('Только просмотр: вы в чужой семье');
    expect(listener).not.toHaveBeenCalled();
  });

  it('отписка снимает слушателя: закрытый экран не должен решать за открытый', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { ok: false, status: 401 })));
    const listener = vi.fn();
    onSignedOut(listener)();

    await requestJson('/api/family', undefined, 'Не получилось загрузить семью').catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
  });
});
