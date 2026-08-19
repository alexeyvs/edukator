// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSignedOut, requestJson, SignedOutError } from './http';

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

  it('отписка снимает слушателя: закрытый экран не должен решать за открытый', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, { ok: false, status: 401 })));
    const listener = vi.fn();
    onSignedOut(listener)();

    await requestJson('/api/family', undefined, 'Не получилось загрузить семью').catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
  });
});
