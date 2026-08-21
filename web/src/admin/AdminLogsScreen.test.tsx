// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLogsScreen, EVENT_NAMES, entryKey, logTime } from './AdminLogsScreen';
import { AdminApp } from './AdminApp';
import {
  ADMIN_LOG_EVENTS,
  adminLogsUrl,
  type AdminApi,
  type AdminLogEntry,
  type AdminLogPage,
} from '../admin-api';
import { HttpError } from '../http';
import '../test-setup';

afterEach(cleanup);

function entry(patch: Partial<AdminLogEntry> = {}): AdminLogEntry {
  return {
    at: '2026-08-21T09:00:00.000Z',
    event: 'server-error',
    message: 'занятие упало',
    ...patch,
  };
}

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    login: vi.fn().mockResolvedValue({ kind: 'admin', email: 'operator@example.com' }),
    logout: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockResolvedValue({
      generatedAt: '2026-08-21T09:00:00.000Z',
      families: [],
      parents: { total: 0, last7Days: 0, last30Days: 0, disabled: 0 },
      children: {
        total: 0, last7Days: 0, last30Days: 0, ready: 0, provisioning: 0, failed: 0, retired: 0,
      },
      stuck: [],
      quota: { day: '2026-08-21', limit: 60, used: 0, children: [] },
      sessions: { parents: 0, admins: 1 },
      devices: { browser: 0, agent: 0, pendingInvites: 0 },
      lockouts: [],
      storage: { controlBytes: 0, childrenBytes: 0, totalBytes: 0, children: [] },
    }),
    logs: vi.fn().mockResolvedValue({ entries: [entry()] } satisfies AdminLogPage),
    impersonate: vi.fn().mockResolvedValue({
      childId: 'ребёнок-1', role: 'browser', expiresAt: '2026-08-21T09:15:00.000Z',
    }),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockRejectedValue(new Error('статистика в этом тесте не спрашивается')),
    child: vi.fn().mockRejectedValue(new Error('карточка в этом тесте не спрашивается')),
    ...overrides,
  };
}

describe('лента аварий', () => {
  it('показывает записи журнала и раскрывает подробности по строке', async () => {
    const api = adminApi({
      logs: vi.fn().mockResolvedValue({
        entries: [entry({
          event: 'tenant-open-failed',
          message: 'файл базы не открылся',
          childId: 'ребёнок-1',
          route: '/api/run/plan',
          status: 503,
          detail: 'SqliteError: unable to open database file',
        })],
      } satisfies AdminLogPage),
    });
    render(<AdminLogsScreen api={api} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('База ребёнка не открылась')).toBeInTheDocument();
    expect(screen.getByText('файл базы не открылся')).toBeInTheDocument();
    // Свёрнутая строка не показывает ни стека, ни маршрута: развёрнутые, они
    // вытолкнули бы с экрана саму ленту.
    expect(screen.queryByText('/api/run/plan')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('/api/run/plan')).toBeInTheDocument();
    expect(screen.getByText('ребёнок-1')).toBeInTheDocument();
    expect(screen.getByText('503')).toBeInTheDocument();
    expect(screen.getByText(/unable to open database file/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('/api/run/plan')).toBeNull();
  });

  it('пустой журнал — не поломка, а «аварий не было»', async () => {
    const api = adminApi({ logs: vi.fn().mockResolvedValue({ entries: [] } satisfies AdminLogPage) });
    render(<AdminLogsScreen api={api} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Аварий не было')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('показывает «Загружаю журнал…», пока первая страница не приехала', () => {
    const api = adminApi({ logs: vi.fn().mockReturnValue(new Promise(() => {})) });
    render(<AdminLogsScreen api={api} onSignedOut={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Загружаю журнал…');
  });

  it('фильтрует по событию и по ребёнку одним запросом', async () => {
    const logs = vi.fn().mockResolvedValue({ entries: [entry()] } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    await waitFor(() => expect(logs).toHaveBeenCalledTimes(1));
    expect(logs).toHaveBeenLastCalledWith({});

    fireEvent.change(screen.getByLabelText('Событие'), { target: { value: 'backup-failed' } });
    fireEvent.change(screen.getByLabelText('Ребёнок'), { target: { value: 'ребёнок-7' } });

    // Ребёнок вводится руками: набранный фильтр не уезжает по знаку, иначе
    // хвост журнала перечитывался бы по разу на букву идентификатора.
    expect(logs).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));

    await waitFor(() => expect(logs).toHaveBeenCalledTimes(2));
    expect(logs).toHaveBeenLastCalledWith({ event: 'backup-failed', child: 'ребёнок-7' });
  });

  it('дописывает следующую страницу по курсору, а не заменяет ею прочитанное', async () => {
    const logs = vi.fn()
      .mockResolvedValueOnce({
        entries: [entry({ message: 'первая' })],
        nextBefore: '2026-08-21T09:00:00.000Z#1',
      } satisfies AdminLogPage)
      .mockResolvedValueOnce({ entries: [entry({ message: 'вторая' })] } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));

    expect(await screen.findByText('вторая')).toBeInTheDocument();
    // Заменой страницы оператор терял бы всё, что успел прочитать выше.
    expect(screen.getByText('первая')).toBeInTheDocument();
    expect(logs).toHaveBeenLastCalledWith({ before: '2026-08-21T09:00:00.000Z#1' });
    // Отданное всё — кнопки больше нет, иначе она молча повторяла бы последнюю
    // страницу.
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('не досыпает отставшую догрузку в свежеотфильтрованную ленту', async () => {
    let releaseAppend = (): void => {};
    const logs = vi.fn()
      .mockResolvedValueOnce({
        entries: [entry({ message: 'нефильтрованная' })],
        nextBefore: '2026-08-21T09:00:00.000Z#1',
      } satisfies AdminLogPage)
      .mockReturnValueOnce(new Promise<AdminLogPage>((resolve) => {
        releaseAppend = () => resolve({
          entries: [entry({ message: 'отставшая' })],
          nextBefore: '2026-08-21T08:00:00.000Z#1',
        });
      }))
      .mockResolvedValueOnce({ entries: [entry({ message: 'отфильтрованная' })] } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    // Фильтр применяется, пока догрузка ещё в пути.
    fireEvent.change(screen.getByLabelText('Событие'), { target: { value: 'backup-failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    await screen.findByText('отфильтрованная');

    releaseAppend();

    // Ответ прошлого вопроса не дописывается к новому: дописать
    // нефильтрованное к отфильтрованному значило бы показать смесь двух разных
    // вопросов, а восстановленный курсор увёл бы и следующую страницу.
    await waitFor(() => expect(screen.queryByText('отставшая')).toBeNull());
    expect(screen.queryByText('нефильтрованная')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('несёт применённый фильтр в запрос следующей страницы', async () => {
    const logs = vi.fn().mockResolvedValue({
      entries: [entry()],
      nextBefore: '2026-08-21T09:00:00.000Z#1',
    } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Событие'), { target: { value: 'sweep-failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    await waitFor(() => expect(logs).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));

    // Курсор считается по отфильтрованной ленте: без фильтра он указывал бы в
    // другое место, и вторая страница поехала бы не с той записи.
    await waitFor(() => expect(logs).toHaveBeenLastCalledWith({
      event: 'sweep-failed',
      before: '2026-08-21T09:00:00.000Z#1',
    }));
  });

  it('начинает ленту заново при смене фильтра', async () => {
    const logs = vi.fn()
      .mockResolvedValueOnce({ entries: [entry({ message: 'без фильтра' })] } satisfies AdminLogPage)
      .mockResolvedValueOnce({ entries: [entry({ message: 'с фильтром' })] } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('без фильтра')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Событие'), { target: { value: 'login-lockout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));

    expect(await screen.findByText('с фильтром')).toBeInTheDocument();
    // Смесь отфильтрованного с нефильтрованным была бы ответом на два разных
    // вопроса сразу.
    expect(screen.queryByText('без фильтра')).toBeNull();
  });

  it('даёт «Повторить» на обрыве сети и подхватывает ленту со второй попытки', async () => {
    const logs = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось загрузить журнал'))
      .mockResolvedValue({ entries: [entry({ message: 'доехало' })] } satisfies AdminLogPage);
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось загрузить журнал');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('доехало')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('сообщает наверх о кончившейся сессии вместо поломки', async () => {
    const onSignedOut = vi.fn();
    const logs = vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' }));
    render(<AdminLogsScreen api={adminApi({ logs })} onSignedOut={onSignedOut} />);

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith('expired'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('называет каждое известное событие по-русски', () => {
    for (const event of ADMIN_LOG_EVENTS) {
      expect(EVENT_NAMES[event]).toMatch(/\p{L}/u);
      expect(EVENT_NAMES[event]).not.toContain('-');
    }
    expect(logTime('2026-08-21T09:00:00.000Z')).toMatch(/12:00:00/u);
    // Ключ строки — отметка плюс место в ленте: аварии приходят пачкой, и
    // одной отметки на ключ не хватает.
    expect(entryKey(entry(), 3)).toBe('2026-08-21T09:00:00.000Z#3');
  });
});

describe('адрес страницы журнала', () => {
  it('не отправляет пустых полей', () => {
    expect(adminLogsUrl()).toBe('/api/admin/logs');
    // Пустой `event=` сервер читает как неизвестное событие и отвечает 400:
    // снятый фильтр ломал бы ленту.
    expect(adminLogsUrl({ child: '', before: '' })).toBe('/api/admin/logs');
  });

  it('складывает фильтры и курсор', () => {
    const url = adminLogsUrl({
      event: 'codex-unavailable',
      child: 'ребёнок-1',
      before: '2026-08-21T09:00:00.000Z#2',
    });
    expect(url).toBe(
      '/api/admin/logs?event=codex-unavailable'
      + `&child=${encodeURIComponent('ребёнок-1')}`
      + `&before=${encodeURIComponent('2026-08-21T09:00:00.000Z#2')}`,
    );
  });
});

describe('корень админки и лента', () => {
  it('уводит на аварии со сводки и возвращает обратно', async () => {
    const api = adminApi();
    render(<AdminApp api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Аварии' }));

    expect(await screen.findByText('занятие упало')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'К сводке' }));

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
  });

  it('показывает вход, когда сессия оператора кончилась на ленте', async () => {
    const api = adminApi({
      logs: vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' })),
    });
    render(<AdminApp api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Аварии' }));

    // 401 на ленте — та же кончившаяся сессия, что и на сводке: разбирать её
    // вторым способом значило бы держать два ответа на один код.
    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument();
  });
});
