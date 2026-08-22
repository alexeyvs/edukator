// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';
import { HttpError } from './http';
import { testAuthApi } from './test-auth-api';
import './test-setup';

afterEach(cleanup);

describe('погашение детской ссылки', () => {
  it('не гасит ссылку до явного подтверждения и отдаёт управление наверх', async () => {
    const api = testAuthApi();
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    const confirm = await screen.findByRole('button', { name: 'Это мой компьютер' });
    expect(api.claimDevice).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onClaimed).toHaveBeenCalledOnce());
    expect(api.claimDevice).toHaveBeenCalledWith('tok');
  });

  // Детская cookie по умолчанию переключает браузер в ученика, поэтому
  // родителю заранее называется смена режима.
  it('предупреждает вошедшего родителя и до его согласия ссылку не жжёт', async () => {
    const api = testAuthApi({ me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'p@example.org' }) });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    expect(await screen.findByRole('heading', { name: 'Это ссылка для ученика' })).toBeInTheDocument();
    // Ссылка одноразовая: предупреждение, которое её уже сожгло, ничего не
    // предупреждает.
    expect(api.claimDevice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Всё равно подключить' }));

    await waitFor(() => expect(onClaimed).toHaveBeenCalledOnce());
    expect(api.claimDevice).toHaveBeenCalledExactlyOnceWith('tok');
  });

  // Неудача вопроса «кто здесь» не прячет явное подтверждение: ссылка живёт
  // сутки и одноразова, а обрыв сети на проверке — не повод сжигать её самому.
  it('даёт подтвердить ссылку и тогда, когда узнать предъявителя не вышло', async () => {
    const api = testAuthApi({ me: vi.fn().mockRejectedValue(new Error('сеть оборвалась')) });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    await waitFor(() => expect(onClaimed).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Это ссылка для ученика' })).not.toBeInTheDocument();
  });

  it('показывает токен агента один раз и не пускает его на занятие', async () => {
    const api = testAuthApi({
      claimDevice: vi.fn().mockResolvedValue({ kind: 'agent', childId: 'c-1', token: 'agent-token' }),
    });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    expect(await screen.findByText('agent-token')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Токен агента' })).toBeInTheDocument();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('объясняет протухшую или отозванную ссылку и не оставляет ученика в загрузке', async () => {
    const api = testAuthApi({
      claimDevice: vi.fn().mockRejectedValue(new HttpError({
        status: 404,
        message: 'Ссылка недействительна или уже использована',
      })),
    });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ссылка недействительна или уже использована');
    expect(screen.queryByText('Подключаю устройство…')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ссылка не работает' })).toBeInTheDocument();
    // Повторять нечего: 404 значит, что погашение уже состоялось.
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('не хоронит живую ссылку из-за не доехавшего запроса и даёт повторить', async () => {
    const claimDevice = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось подключить устройство'))
      .mockResolvedValueOnce({ kind: 'child', childId: 'c-1' });
    const api = testAuthApi({ claimDevice });
    const onClaimed = vi.fn();
    render(<JoinScreen api={api} token="tok" onClaimed={onClaimed} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось подключить устройство');
    // Ссылку сервер не тронул, поэтому «попросите новую» здесь не пишется.
    expect(screen.queryByRole('heading', { name: 'Ссылка не работает' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(onClaimed).toHaveBeenCalledOnce());
    expect(claimDevice).toHaveBeenCalledTimes(2);
  });

  it('не гасит одноразовую ссылку дважды при повторном запуске эффекта', async () => {
    const api = testAuthApi();
    const onClaimed = vi.fn();
    // Именно StrictMode, а не повторный `render` с теми же свойствами: у него
    // не меняются зависимости эффекта, и без двойного запуска замок проверяется
    // на сценарии, где его и без того не спрашивают.
    render(
      <StrictMode><JoinScreen api={api} token="tok" onClaimed={onClaimed} /></StrictMode>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    await waitFor(() => expect(onClaimed).toHaveBeenCalled());
    expect(api.claimDevice).toHaveBeenCalledOnce();
  });
});
