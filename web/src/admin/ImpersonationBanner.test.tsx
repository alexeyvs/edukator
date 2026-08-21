// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImpersonationBanner, minutesLeft } from './ImpersonationBanner';
import type { AdminApi } from '../admin-api';
import type { Impersonation } from '../auth-api';
import { requestJson } from '../http';
import '../test-setup';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const NOW = new Date('2026-08-21T09:00:00.000Z').getTime();

function impersonation(patch: Partial<Impersonation> = {}): Impersonation {
  return {
    adminEmail: 'оператор@example.com',
    childName: 'Тимофей',
    role: 'browser',
    expiresAt: '2026-08-21T09:15:00.000Z',
    ...patch,
  };
}

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    login: vi.fn().mockRejectedValue(new Error('вход в этом тесте не нужен')),
    logout: vi.fn().mockRejectedValue(new Error('выход оператора в этом тесте не нужен')),
    overview: vi.fn().mockRejectedValue(new Error('сводка в этом тесте не нужна')),
    logs: vi.fn().mockRejectedValue(new Error('журнал в этом тесте не нужен')),
    impersonate: vi.fn().mockRejectedValue(new Error('заход в этом тесте не начинается')),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockRejectedValue(new Error('статистика в этом тесте не нужна')),
    child: vi.fn().mockRejectedValue(new Error('карточка в этом тесте не нужна')),
    ...overrides,
  };
}

describe('полоса захода оператора', () => {
  it('называет оператора, семью, роль и остаток срока', () => {
    render(
      <ImpersonationBanner
        api={adminApi()}
        impersonation={impersonation()}
        now={() => NOW}
        onLeft={vi.fn()}
      />,
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('оператор@example.com');
    expect(banner).toHaveTextContent('Тимофей');
    expect(banner).toHaveTextContent('как ученик');
    expect(banner).toHaveTextContent('Осталось 15 мин');
  });

  it('называет роль родителя её словом, а не словом протокола', () => {
    render(
      <ImpersonationBanner
        api={adminApi()}
        impersonation={impersonation({ role: 'parent' })}
        now={() => NOW}
        onLeft={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('как родитель');
  });

  it('показывает отказ замка на запись, а не оставляет его экрану', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ error: 'Только просмотр: вы в чужой семье', code: 'read-only' }),
    }));
    render(
      <ImpersonationBanner
        api={adminApi()}
        impersonation={impersonation()}
        now={() => NOW}
        onLeft={vi.fn()}
      />,
    );

    await requestJson('/api/session/answer', { method: 'POST' }, 'Не получилось ответить')
      .catch(() => undefined);

    expect(await screen.findByText('Только просмотр: вы в чужой семье')).toBeInTheDocument();
  });

  it('по кнопке гасит заход и возвращает оператора в админку', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const left = vi.fn();
    render(
      <ImpersonationBanner
        api={adminApi({ stopImpersonation: stop })}
        impersonation={impersonation()}
        now={() => NOW}
        onLeft={left}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Выйти в админку' }));

    await waitFor(() => expect(left).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledOnce();
  });

  it('не уводит в админку, пока сервер не подтвердил выход', async () => {
    const left = vi.fn();
    render(
      <ImpersonationBanner
        api={adminApi({ stopImpersonation: vi.fn().mockRejectedValue(new Error('Сеть недоступна')) })}
        impersonation={impersonation()}
        now={() => NOW}
        onLeft={left}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Выйти в админку' }));

    // Cookie захода `HttpOnly`: уход по неподтверждённому выходу означал бы
    // живой заход, о котором уже никто не рассказывает.
    expect(await screen.findByText('Сеть недоступна')).toBeInTheDocument();
    expect(left).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Выйти в админку' })).toBeEnabled();
  });

  it('называет вышедший срок концом, а не нулём минут', () => {
    render(
      <ImpersonationBanner
        api={adminApi()}
        impersonation={impersonation()}
        now={() => new Date('2026-08-21T09:20:00.000Z').getTime()}
        onLeft={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Срок захода вышел');
  });
});

describe('остаток срока захода', () => {
  it('округляет вверх: начавшаяся минута ещё не кончилась', () => {
    expect(minutesLeft('2026-08-21T09:15:00.000Z', NOW)).toBe(15);
    expect(minutesLeft('2026-08-21T09:00:01.000Z', NOW)).toBe(1);
  });

  it('не уходит в минус на протухшем заходе', () => {
    expect(minutesLeft('2026-08-21T08:59:00.000Z', NOW)).toBe(0);
    expect(minutesLeft('2026-08-21T09:00:00.000Z', NOW)).toBe(0);
  });
});
