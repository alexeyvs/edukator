// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteScreen } from './InviteScreen';
import { HttpError } from './http';
import { testAuthApi } from './test-auth-api';
import './test-setup';

afterEach(cleanup);

function fill(password: string, repeat: string): void {
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Пароль ещё раз'), { target: { value: repeat } });
}

describe('приглашение родителя', () => {
  it('показывает адрес из ссылки и входит после установки пароля', async () => {
    const api = testAuthApi();
    const onSignedIn = vi.fn();
    render(<InviteScreen api={api} token="tok" onSignedIn={onSignedIn} />);

    expect(await screen.findByText('Учётная запись: parent@example.org')).toBeInTheDocument();
    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    // Наружу уходит только факт «пароль поставлен»: кто предъявитель, решает
    // `me`, а не этот ответ — ссылку открывают и в браузере ученика.
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(onSignedIn).toHaveBeenCalledWith();
    expect(api.redeemInvite).toHaveBeenCalledWith('tok', 'длинный-пароль');
  });

  it('не шлёт на сервер несовпавшие и короткие пароли', async () => {
    const api = testAuthApi();
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'другой-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Пароли не совпадают');

    fill('коротко', 'коротко');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('от 10 до 128 знаков');

    // Верхняя граница тоже своя: сервер отвергает длинный пароль до KDF, и без
    // проверки здесь форма получала бы 400 на пароль, который выглядит годным.
    fill('к'.repeat(129), 'к'.repeat(129));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('от 10 до 128 знаков');
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it('честно говорит про протухшую ссылку и не предлагает пароль', async () => {
    const api = testAuthApi({
      readInvite: vi.fn().mockRejectedValue(new HttpError({
        status: 404,
        message: 'Ссылка недействительна или уже использована',
      })),
    });
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ссылка недействительна или уже использована');
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ссылка не работает' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
  });

  it('не зовёт за новой ссылкой, когда чтение просто не доехало', async () => {
    const readInvite = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось проверить ссылку'))
      .mockResolvedValueOnce({ email: 'parent@example.org' });
    const api = testAuthApi({ readInvite });
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось проверить ссылку');
    expect(screen.queryByRole('heading', { name: 'Ссылка не работает' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Учётная запись: parent@example.org')).toBeInTheDocument();
    expect(readInvite).toHaveBeenCalledTimes(2);
  });

  it('оставляет форму, когда пароль до сервера просто не доехал', async () => {
    const api = testAuthApi({
      redeemInvite: vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    });
    const onSignedIn = vi.fn();
    render(<InviteScreen api={api} token="tok" onSignedIn={onSignedIn} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    // Ссылку это не сожгло: пароль вводят тут же ещё раз, а не идут за новой.
    expect(screen.getByLabelText('Пароль')).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('зовёт за новой ссылкой, когда погашение ответило 404', async () => {
    const api = testAuthApi({
      redeemInvite: vi.fn().mockRejectedValue(new HttpError({
        status: 404,
        message: 'Ссылка недействительна или уже использована',
      })),
    });
    const onSignedIn = vi.fn();
    render(<InviteScreen api={api} token="tok" onSignedIn={onSignedIn} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    // Приглашение погашено или просрочено: форма пароля здесь — предложение
    // подбирать пароль к мёртвой ссылке, и родитель остаётся на ней навсегда.
    expect(await screen.findByRole('heading', { name: 'Ссылка не работает' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('оставляет короткий пароль на форме: 400 про ссылку ничего не значит', async () => {
    const api = testAuthApi({
      redeemInvite: vi.fn().mockRejectedValue(new HttpError({
        status: 400,
        message: 'Пароль должен быть от 10 до 256 знаков',
      })),
    });
    render(<InviteScreen api={api} token="tok" onSignedIn={vi.fn()} />);
    await screen.findByText('Учётная запись: parent@example.org');

    fill('длинный-пароль', 'длинный-пароль');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('от 10 до 256 знаков');
    expect(screen.getByLabelText('Пароль')).toBeInTheDocument();
  });
});
