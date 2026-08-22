// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginScreen, MIN_ADMIN_PASSWORD_LENGTH } from './AdminLoginScreen';
import type { AdminApi } from '../admin-api';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(cleanup);

const PASSWORD = 'пароль-оператора-подлиннее';

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  // Состав методов держит общий помощник: всё, что этому файлу нужно,
  // названо здесь, остальное отказывает.
  return testAdminApi({
    login: vi.fn().mockResolvedValue({ kind: 'admin', email: 'operator@example.com' }),
    logout: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockRejectedValue(new Error('сводка в этом тесте не нужна')),
    logs: vi.fn().mockRejectedValue(new Error('журнал в этом тесте не нужен')),
    impersonate: vi.fn().mockResolvedValue({
      childId: 'ребёнок-1', role: 'browser', expiresAt: '2026-08-21T09:15:00.000Z',
    }),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockRejectedValue(new Error('статистика в этом тесте не нужна')),
    child: vi.fn().mockRejectedValue(new Error('карточка в этом тесте не нужна')),
    ...overrides,
  });
}

function fill(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
}

describe('вход оператора', () => {
  it('отдаёт наверх адрес после верного пароля', async () => {
    const api = adminApi();
    const onSignedIn = vi.fn();
    render(<AdminLoginScreen api={api} onSignedIn={onSignedIn} />);

    fill('  operator@example.com  ', PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('operator@example.com'));
    expect(api.login).toHaveBeenCalledWith('operator@example.com', PASSWORD);
  });

  it('показывает отказ сервера и стирает только пароль', async () => {
    const api = adminApi({ login: vi.fn().mockRejectedValue(new Error('Неверный адрес или пароль')) });
    const onSignedIn = vi.fn();
    render(<AdminLoginScreen api={api} onSignedIn={onSignedIn} />);

    fill('operator@example.com', `${PASSWORD}-не тот`);
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный адрес или пароль');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Электронная почта')).toHaveValue('operator@example.com');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
  });

  it('не тратит попытку на пароль короче предела', () => {
    const api = adminApi();
    render(<AdminLoginScreen api={api} onSignedIn={vi.fn()} />);

    fill('operator@example.com', 'к'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1));
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    // Счётчик перебора считает и заведомо негодные попытки: отправленная
    // опечатка приближала бы локаут оператора собственным клиентом.
    expect(api.login).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Пароль оператора короче 16 знаков');
  });

  it('объясняет, почему вход показан снова', () => {
    render(
      <AdminLoginScreen
        api={adminApi()}
        notice="Сессия закончилась. Войдите заново."
        onSignedIn={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Сессия закончилась. Войдите заново.');
  });

  // Число вписано руками нарочно: тест, берущий предел из той же константы, её
  // подмену не поймает, а поднятый на сервере минимум оставил бы клиент, молча
  // отправляющий короткий пароль.
  it('держит копию минимума пароля оператора', () => {
    expect(MIN_ADMIN_PASSWORD_LENGTH).toBe(16);
  });
});
