// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserHomeApi } from './home-api';
import { browserBossApi } from './boss-api';
import { browserProfileApi } from './profile-api';
import { browserParentsApi, type ComputerAccessError } from './parents-api';
import { browserRunApi, RunApiError } from './run-api';
import { browserLearningApi } from './learning-api';

function response(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('браузерные API-адаптеры', () => {
  it('собирает URL и тела запросов главного экрана и профиля', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await browserHomeApi.plan();
    await browserHomeApi.profile();
    await browserHomeApi.start('math', 'math.fractions');
    await browserHomeApi.startBoss('math.fractions');
    await browserHomeApi.startTriage('english');
    await browserHomeApi.finish(7);
    await browserProfileApi.read();
    await browserParentsApi.read();
    await browserParentsApi.readRun(42);
    await browserParentsApi.changeComputerAccess('blocked', '123456');
    await browserProfileApi.save({
      name: 'Тимофей',
      interests: ['скейт'],
      examDate: null,
      partnerName: 'Кекс',
    });

    expect(fetch.mock.calls).toEqual([
      ['/api/run/plan'],
      ['/api/profile'],
      ['/api/run/start', expect.objectContaining({
        method: 'POST', body: '{"subject":"math","topic_id":"math.fractions"}',
      })],
      ['/api/boss/start', expect.objectContaining({
        method: 'POST',
        body: '{"topic_id":"math.fractions"}',
      })],
      ['/api/triage/start', expect.objectContaining({ method: 'POST', body: '{"subject":"english"}' })],
      ['/api/run/7/finish', { method: 'POST' }],
      ['/api/profile'],
      ['/api/parents'],
      ['/api/parents/runs/42'],
      ['/api/parents/computer-access', expect.objectContaining({
        method: 'PUT',
        headers: { authorization: 'Bearer 123456', 'content-type': 'application/json' },
        body: '{"mode":"blocked"}',
      })],
      ['/api/profile', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('Тимофей') })],
    ]);
  });

  it('переводит поля занятия в серверный snake_case-контракт', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await browserRunApi.next(3);
    await browserRunApi.next(3, 9);
    await browserRunApi.answer({
      runId: 3,
      taskId: 8,
      answer: '40',
      hintUsed: false,
      durationMs: 900,
    });
    await browserRunApi.answer({
      runId: 3,
      taskId: 9,
      answer: '45',
      hintUsed: true,
      durationMs: 1200,
      retryAttemptId: 17,
    });
    await browserRunApi.skipRetry(3, 9);
    await browserRunApi.dispute(11);
    await browserRunApi.finish(3);
    await browserRunApi.triageNext(4);

    expect(fetch.mock.calls).toEqual([
      ['/api/session/next?runId=3'],
      ['/api/session/next?runId=3&excludeTaskId=9'],
      ['/api/session/answer', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          runId: 3,
          task_id: 8,
          answer: '40',
          hint_used: false,
          duration_ms: 900,
        }),
      })],
      ['/api/session/answer', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          runId: 3,
          task_id: 9,
          answer: '45',
          hint_used: true,
          duration_ms: 1200,
          retry_attempt_id: 17,
        }),
      })],
      ['/api/session/retry/skip', expect.objectContaining({
        method: 'POST',
        body: '{"runId":3,"task_id":9}',
      })],
      ['/api/session/dispute', expect.objectContaining({
        method: 'POST',
        body: '{"attempt_id":11}',
      })],
      ['/api/run/3/finish', { method: 'POST' }],
      ['/api/triage/4/next'],
    ]);
  });

  it('собирает boss-запросы без подсказок и с общим спором занятия', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await browserBossApi.next(5);
    await browserBossApi.answer({ runId: 5, taskId: 17, answer: '42', durationMs: 900 });
    await browserBossApi.dispute(23);
    await browserBossApi.concede(5);

    expect(fetch.mock.calls).toEqual([
      ['/api/boss/5/next'],
      ['/api/boss/5/answer', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          task_id: 17,
          answer: '42',
          hint_used: false,
          duration_ms: 900,
        }),
      })],
      ['/api/session/dispute', expect.objectContaining({
        method: 'POST',
        body: '{"attempt_id":23}',
      })],
      ['/api/boss/5/concede', { method: 'POST' }],
    ]);
  });

  it('собирает запросы чтения, открытия, теста и learning-финиша', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await browserLearningApi.read(21);
    await browserLearningApi.open(21);
    await browserLearningApi.startTest(21);
    await browserLearningApi.finish(31);

    expect(fetch.mock.calls).toEqual([
      ['/api/learning/21'],
      ['/api/learning/21/open', { method: 'POST' }],
      ['/api/learning/21/test', { method: 'POST' }],
      ['/api/learning/run/31/finish', { method: 'POST' }],
    ]);
  });

  it('сохраняет статус и код ошибки занятия и использует безопасные fallback-сообщения', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Очередь пуста', code: 'no-task' }, { ok: false, status: 503 }),
    ));
    await expect(browserRunApi.next(1)).rejects.toMatchObject({
      name: 'RunApiError',
      message: 'Очередь пуста',
      status: 503,
      code: 'no-task',
    } satisfies Partial<RunApiError>);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response(null, { ok: false, status: 500 }),
    ));
    await expect(browserHomeApi.plan()).rejects.toThrow('Сервер не смог обработать запрос');
    await expect(browserProfileApi.read()).rejects.toThrow('Не получилось сохранить профиль');
    await expect(browserParentsApi.read()).rejects.toThrow('Не получилось загрузить сводку');
    await expect(browserRunApi.next(1)).rejects.toMatchObject({
      message: 'Сервер не смог обработать запрос',
      status: 500,
      code: undefined,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Профиль заблокирован' }, { ok: false, status: 409 }),
    ));
    await expect(browserProfileApi.read()).rejects.toThrow('Профиль заблокирован');
    await expect(browserParentsApi.read()).rejects.toThrow('Профиль заблокирован');
  });

  it('сохраняет HTTP-статус ошибки управления родительским доступом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Неверный PIN родителя' }, { ok: false, status: 401 }),
    ));

    await expect(browserParentsApi.changeComputerAccess('unlocked', '000000')).rejects.toMatchObject({
      name: 'ComputerAccessError',
      message: 'Неверный PIN родителя',
      status: 401,
    } satisfies Partial<ComputerAccessError>);
  });

  it('не маскирует не-JSON ответ как успешный контракт', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('not json')),
    }));

    await expect(browserRunApi.next(1)).rejects.toThrow('not json');
  });
});
