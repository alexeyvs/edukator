// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from './LoginScreen';
import type { AuthApi } from './auth-api';
import './test-setup';

afterEach(cleanup);

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    login: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    switchPersona: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    ...overrides,
  };
}

function fill(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
}

describe('вход родителя', () => {
  it('отдаёт наверх разобранного предъявителя после верного пароля', async () => {
    const api = authApi();
    const onSignedIn = vi.fn();
    render(<LoginScreen api={api} onSignedIn={onSignedIn} />);

    fill('  parent@example.org  ', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({
      kind: 'parent', email: 'parent@example.org',
    }));
    expect(api.login).toHaveBeenCalledWith('parent@example.org', 'длинный-пароль');
  });

  it('показывает отказ сервера и стирает только пароль', async () => {
    const api = authApi({ login: vi.fn().mockRejectedValue(new Error('Неверный адрес или пароль')) });
    const onSignedIn = vi.fn();
    render(<LoginScreen api={api} onSignedIn={onSignedIn} />);

    fill('parent@example.org', 'не тот');
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный адрес или пароль');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Электронная почта')).toHaveValue('parent@example.org');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
  });

  it('объясняет, почему вход показан снова', () => {
    render(<LoginScreen api={authApi()} notice="Сессия закончилась. Войдите заново." onSignedIn={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Сессия закончилась. Войдите заново.');
  });
});
