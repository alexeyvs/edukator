// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteScreen } from './InviteScreen';
import type { AuthApi } from './auth-api';
import './test-setup';

afterEach(cleanup);

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    login: vi.fn().mockResolvedValue({ kind: 'anonymous' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    ...overrides,
  };
}

function fill(password: string, repeat: string): void {
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Пароль ещё раз'), { target: { value: repeat } });
}

describe('приглашение родителя', () => {
  it('показывает адрес из ссылки и входит после установки пароля', async () => {
    const api = authApi();
    const onSignedIn = vi.fn();
    render(<InviteScreen api={api} token="tok" onSignedIn={onSignedIn} />);

    expect(await screen.findByText('Учётная запись: parent@example.org')).toBeInTheDocument();
    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({
      kind: 'parent', email: 'parent@example.org',
    }));
    expect(api.redeemInvite).toHaveBeenCalledWith('tok', 'длинный-пароль');
  });

  it('не шлёт на сервер несовпавшие и короткие пароли', async () => {
    const api = authApi();
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'другой-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Пароли не совпадают');

    fill('коротко', 'коротко');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Пароль короче 10 знаков');
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it('честно говорит про протухшую ссылку и не предлагает пароль', async () => {
    const api = authApi({
      readInvite: vi.fn().mockRejectedValue(new Error('Ссылка недействительна или уже использована')),
    });
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ссылка недействительна или уже использована');
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
  });

  it('показывает отказ сервера при погашении уже использованной ссылки', async () => {
    const api = authApi({
      redeemInvite: vi.fn().mockRejectedValue(new Error('Ссылка недействительна или уже использована')),
    });
    const onSignedIn = vi.fn();
    render(<InviteScreen api={api} token="tok" onSignedIn={onSignedIn} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ссылка недействительна или уже использована');
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
