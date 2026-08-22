// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from './LoginScreen';
import { testAuthApi } from './test-auth-api';
import './test-setup';

afterEach(cleanup);

function fill(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
}

describe('вход родителя', () => {
  it('отдаёт наверх разобранного предъявителя после верного пароля', async () => {
    const api = testAuthApi();
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
    const api = testAuthApi({ login: vi.fn().mockRejectedValue(new Error('Неверный адрес или пароль')) });
    const onSignedIn = vi.fn();
    render(<LoginScreen api={api} onSignedIn={onSignedIn} />);

    fill('parent@example.org', 'не тот');
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный адрес или пароль');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Электронная почта')).toHaveValue('parent@example.org');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
  });

  it('пускает адрес с кириллицей: сервер такие принимает', async () => {
    const api = testAuthApi();
    render(<LoginScreen api={api} onSignedIn={vi.fn()} />);

    // `type="email"` браузер проверяет ASCII-регуляркой из спеки и такой адрес
    // до отправки не допускает вовсе — молча, без единого сообщения. Сервер же
    // его принимает (`normalizeEmail` смотрит на одну собаку), так что форма
    // отказывала бы во входе учётной записи, которая заведена и работает.
    fireEvent.change(screen.getByLabelText('Электронная почта'), {
      target: { value: 'родитель@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'пароль-подлиннее' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => expect(api.login)
      .toHaveBeenCalledWith('родитель@example.com', 'пароль-подлиннее'));
  });

  it('объясняет, почему вход показан снова', () => {
    render(<LoginScreen api={testAuthApi()} notice="Сессия закончилась. Войдите заново." onSignedIn={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Сессия закончилась. Войдите заново.');
  });
});
