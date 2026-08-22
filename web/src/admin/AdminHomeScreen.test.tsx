// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminHomeScreen, childState, megabytes } from './AdminHomeScreen';
import { AdminApp } from './AdminApp';
import type { AdminApi, AdminOverview } from '../admin-api';
import { HttpError } from '../http';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(cleanup);

const MB = 1024 * 1024;

function overview(patch: Partial<AdminOverview> = {}): AdminOverview {
  return {
    generatedAt: '2026-08-21T09:00:00.000Z',
    families: [
      {
        parentId: 'p-1',
        email: 'первый@example.com',
        createdAt: '2026-08-01T09:00:00.000Z',
        children: [
          {
            childId: 'ребёнок-1',
            name: 'Старший',
            status: 'ready',
            lastActivityAt: '2026-08-21T08:00:00.000Z',
            createdAt: '2026-08-01T09:00:00.000Z',
          },
          {
            childId: 'ребёнок-2',
            name: 'Младшая',
            status: 'provisioning',
            createdAt: '2026-08-20T09:00:00.000Z',
          },
        ],
      },
      {
        parentId: 'p-2',
        email: 'пустой@example.com',
        disabledAt: '2026-08-19T09:00:00.000Z',
        createdAt: '2026-08-02T09:00:00.000Z',
        children: [],
      },
    ],
    parents: { total: 2, last7Days: 1, last30Days: 2, disabled: 1 },
    children: { total: 2, last7Days: 1, last30Days: 2, ready: 1, provisioning: 1, failed: 0, retired: 0 },
    stuck: [],
    quota: { day: '2026-08-21', limit: 60, used: 7, children: [{ childId: 'ребёнок-1', used: 7 }] },
    sessions: { parents: 1, admins: 1 },
    devices: { browser: 2, agent: 1, pendingInvites: 1 },
    lockouts: [],
    storage: {
      controlBytes: MB,
      childrenBytes: 3 * MB,
      totalBytes: 4 * MB,
      freeBytes: 100 * MB,
      children: [{ childId: 'ребёнок-1', bytes: 3 * MB, present: true }],
    },
    ...patch,
  };
}

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  // Состав методов держит общий помощник: всё, что этому файлу нужно,
  // названо здесь, остальное отказывает.
  return testAdminApi({
    login: vi.fn().mockResolvedValue({ kind: 'admin', email: 'operator@example.com' }),
    logout: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockResolvedValue(overview()),
    logs: vi.fn().mockResolvedValue({ entries: [] }),
    impersonate: vi.fn().mockResolvedValue({
      childId: 'ребёнок-1', role: 'browser', expiresAt: '2026-08-21T09:15:00.000Z',
    }),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockRejectedValue(new Error('статистика в этом тесте не спрашивается')),
    child: vi.fn().mockRejectedValue(new Error('карточка в этом тесте не спрашивается')),
    createFamily: vi.fn().mockResolvedValue({
      parent: {
        parentId: 'p-3',
        email: 'новый@example.com',
        hasPassword: false,
        hasPin: false,
        createdAt: '2026-08-21T09:00:00.000Z',
      },
      invite: { path: '/invite/new-link', expiresAt: '2026-08-28T09:00:00.000Z' },
    }),
    issueParentInvite: vi.fn().mockResolvedValue({
      invite: { path: '/invite/reset', expiresAt: '2026-08-28T09:00:00.000Z' },
    }),
    setParentPassword: vi.fn().mockResolvedValue({
      parent: {
        parentId: 'p-1',
        email: 'первый@example.com',
        hasPassword: true,
        hasPin: false,
        createdAt: '2026-08-01T09:00:00.000Z',
      },
    }),
    ...overrides,
  });
}

describe('заведение семьи оператором', () => {
  function fillEmail(value: string): void {
    fireEvent.change(screen.getByLabelText('Адрес родителя'), { target: { value } });
  }

  it('заводит семью, показывает целый адрес ссылки и перечитывает сводку', async () => {
    const api = adminApi();
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fillEmail('новый@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Завести семью' }));

    await waitFor(() => expect(api.createFamily).toHaveBeenCalledWith('новый@example.com'));
    // Ссылка показывается целым адресом: сервер отдаёт путь, а родителю нужен
    // адрес, по которому он откроет её у себя.
    expect(await screen.findByText(/\/invite\/new-link/u)).toBeInTheDocument();
    // Сводка перечитывается: заведённая семья обязана появиться в списке.
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
  });

  it('не шлёт на сервер адрес, не похожий на адрес', async () => {
    const api = adminApi();
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fillEmail('не адрес');
    fireEvent.click(screen.getByRole('button', { name: 'Завести семью' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('электронную почту');
    expect(api.createFamily).not.toHaveBeenCalled();
  });

  it('показывает отказ по уже заведённому адресу и оставляет набранное', async () => {
    const api = adminApi({
      createFamily: vi.fn().mockRejectedValue(new HttpError({
        status: 409,
        message: 'Родитель с адресом новый@example.com уже заведён',
      })),
    });
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fillEmail('новый@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Завести семью' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('уже заведён');
    expect(screen.getByLabelText('Адрес родителя')).toHaveValue('новый@example.com');
  });
});

describe('сброс пароля семьи оператором', () => {
  it('выпускает ссылку на смену пароля и показывает её один раз', async () => {
    const api = adminApi();
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fireEvent.click(screen.getAllByRole('button', { name: 'Ссылка на смену пароля' })[0] as HTMLElement);

    await waitFor(() => expect(api.issueParentInvite).toHaveBeenCalledWith('p-1'));
    expect(await screen.findByText(/\/invite\/reset/u)).toBeInTheDocument();
  });

  it('ставит пароль сам и предупреждает, чем это отличается от ссылки', async () => {
    const api = adminApi();
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fireEvent.click(screen.getAllByRole('button', { name: 'Задать пароль' })[0] as HTMLElement);
    // Оператор, поставивший пароль, знает его: войти этой семьёй он сможет уже
    // без записи о заходе. Форма обязана сказать это до нажатия, а не после.
    expect(screen.getByRole('note')).toHaveTextContent(/зна/u);
    fireEvent.change(screen.getByLabelText('Новый пароль семьи'), {
      target: { value: 'совсем-другой-пароль' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль семьи' }));

    await waitFor(() => expect(api.setParentPassword)
      .toHaveBeenCalledWith('p-1', 'совсем-другой-пароль'));
    expect(await screen.findByText(/Пароль поставлен/u)).toBeInTheDocument();
  });

  it('не шлёт короткий пароль семьи', async () => {
    const api = adminApi();
    render(<AdminHomeScreen api={api} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    fireEvent.click(screen.getAllByRole('button', { name: 'Задать пароль' })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Новый пароль семьи'), { target: { value: 'коротко' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль семьи' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('от 10 до 128 знаков');
    expect(api.setParentPassword).not.toHaveBeenCalled();
  });

  it('не предлагает ни ссылки, ни пароля отключённой семье', async () => {
    render(<AdminHomeScreen api={adminApi()} email="operator@example.com" onSignedOut={vi.fn()} />);
    await screen.findByText('Семьи');

    // Отключённому родителю сервер отказывает 409 на обоих маршрутах: кнопка,
    // которая гарантированно кончается отказом, — это не действие, а ловушка.
    expect(screen.getAllByRole('button', { name: 'Ссылка на смену пароля' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Задать пароль' })).toHaveLength(1);
  });
});

describe('главный экран админки', () => {
  it('показывает цифры слоя 1 и список семей с детьми', async () => {
    render(<AdminHomeScreen api={adminApi()} email="operator@example.com" onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    expect(screen.getByText('первый@example.com')).toBeInTheDocument();
    expect(screen.getByText('Старший')).toBeInTheDocument();
    expect(screen.getByText(/Готов к занятиям/u)).toBeInTheDocument();
    expect(screen.getByText(/Ни разу не занимался/u)).toBeInTheDocument();
    // Отключённая семья без детей остаётся видимой: это состояние, а не пустота.
    expect(screen.getByText('пустой@example.com')).toBeInTheDocument();
    expect(screen.getByText('Детей нет')).toBeInTheDocument();
    expect(screen.getByText('4.0 МБ')).toBeInTheDocument();
    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
  });

  it('заводит заход в семью обеими ролями и уводит к настоящим экранам', async () => {
    const impersonate = vi.fn().mockResolvedValue({
      childId: 'ребёнок-1', role: 'parent', expiresAt: '2026-08-21T09:15:00.000Z',
    });
    const entered = vi.fn();
    render(
      <AdminHomeScreen
        api={adminApi({ impersonate })}
        onEntered={entered}
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти как родитель' }));
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    expect(impersonate).toHaveBeenCalledWith('ребёнок-1', 'parent');

    // Начавшийся заход запирает кнопки до конца ухода. `onEntered` по
    // умолчанию — `location.assign`, а он асинхронный: отпустив кнопки сразу,
    // экран пускал бы второй щелчок в окно между ответом и уходом страницы, а
    // второй заход гасит первый, сбрасывает счётчик отказов записи и кладёт в
    // `admin_audit` вторую строку `impersonation-start` на одно намерение.
    fireEvent.click(screen.getByRole('button', { name: 'Войти как ребёнок' }));
    await Promise.resolve();
    expect(impersonate).toHaveBeenCalledTimes(1);
  });

  it('отпускает кнопки захода, когда заход не удался', async () => {
    const impersonate = vi.fn()
      .mockRejectedValueOnce(new Error('сеть отвалилась'))
      .mockResolvedValue({
        childId: 'ребёнок-1', role: 'browser', expiresAt: '2026-08-21T09:15:00.000Z',
      });
    const entered = vi.fn();
    render(
      <AdminHomeScreen
        api={adminApi({ impersonate })}
        onEntered={entered}
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти как ребёнок' }));
    expect(await screen.findByText('сеть отвалилась')).toBeInTheDocument();

    // Отказ — единственное место, где кнопки отпираются: без него обрыв сети
    // запирал бы оператору заход навсегда.
    fireEvent.click(screen.getByRole('button', { name: 'Войти как ребёнок' }));
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    expect(impersonate).toHaveBeenCalledTimes(2);
  });

  it('не предлагает захода в ребёнка без базы', async () => {
    render(<AdminHomeScreen api={adminApi()} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    // Готовый ребёнок в списке один: у второго заведение не доехало, и заход в
    // него кончился бы отказом на первом же экране.
    expect(screen.getAllByRole('button', { name: 'Войти как ребёнок' })).toHaveLength(1);
    expect(screen.getByText('Младшая')).toBeInTheDocument();
  });

  it('не предлагает захода в выведенного ребёнка', async () => {
    // `retireChild` трогает только `retired_at` и оставляет `status = 'ready'`,
    // а `isChildServiceable` требует обоих. Кнопка по одному `status` обещала бы
    // заход, который сервер отвергает «Ребёнок не найден».
    const retired = overview({
      families: [
        {
          parentId: 'p-1',
          email: 'первый@example.com',
          createdAt: '2026-08-01T09:00:00.000Z',
          children: [
            {
              childId: 'ребёнок-1',
              name: 'Выведенный',
              status: 'ready',
              createdAt: '2026-08-01T09:00:00.000Z',
              retiredAt: '2026-08-15T09:00:00.000Z',
            },
          ],
        },
      ],
    });
    render(
      <AdminHomeScreen
        api={adminApi({ overview: vi.fn().mockResolvedValue(retired) })}
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Выведенный')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Войти как ребёнок' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Войти как родитель' })).toBeNull();
  });

  it('называет отказ захода и оставляет оператора в админке', async () => {
    const entered = vi.fn();
    render(
      <AdminHomeScreen
        api={adminApi({ impersonate: vi.fn().mockRejectedValue(new Error('Ребёнок не найден')) })}
        onEntered={entered}
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти как ребёнок' }));

    expect(await screen.findByText('Ребёнок не найден')).toBeInTheDocument();
    expect(entered).not.toHaveBeenCalled();
    // Сводка остаётся на месте: отказ захода — не поломка экрана.
    expect(screen.getByText('Семьи')).toBeInTheDocument();
  });

  it('сообщает наверх о кончившейся сессии и с кнопки захода', async () => {
    const onSignedOut = vi.fn();
    render(
      <AdminHomeScreen
        api={adminApi({
          impersonate: vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' })),
        })}
        onEntered={vi.fn()}
        onSignedOut={onSignedOut}
      />,
    );

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти как ребёнок' }));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith('expired'));
  });

  it('называет застрявших и запертый перебором вход', async () => {
    const api = adminApi({
      overview: vi.fn().mockResolvedValue(overview({
        stuck: [{
          childId: 'ребёнок-3',
          parentId: 'p-1',
          name: 'Не завелась',
          status: 'failed',
          createdAt: '2026-08-20T09:00:00.000Z',
        }],
        lockouts: [{
          scope: 'email',
          kind: 'admin',
          key: 'operator@example.com',
          failures: 5,
          lastFailedAt: '2026-08-21T08:55:00.000Z',
          retryAfterMs: 9 * 60 * 1000,
        }],
      })),
    });
    render(<AdminHomeScreen api={api} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Заведение не доехало')).toBeInTheDocument();
    expect(screen.getByText(/Не завелась/u)).toBeInTheDocument();
    expect(screen.getByText('Вход заперт перебором')).toBeInTheDocument();
    expect(screen.getByText(/ещё 9 мин/u)).toBeInTheDocument();
  });

  it('сообщает наверх о кончившейся сессии вместо поломки', async () => {
    const onSignedOut = vi.fn();
    const api = adminApi({
      overview: vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' })),
    });
    render(<AdminHomeScreen api={api} onSignedOut={onSignedOut} />);

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('даёт «Повторить» на обрыве сети и подхватывает сводку со второй попытки', async () => {
    const overviewCall = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось загрузить сводку'))
      .mockResolvedValue(overview());
    render(<AdminHomeScreen api={adminApi({ overview: overviewCall })} onSignedOut={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось загрузить сводку');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    expect(overviewCall).toHaveBeenCalledTimes(2);
  });

  it('оставляет ленту аварий и выход достижимыми, когда сводка не загрузилась', async () => {
    // Сводка ломается ровно тогда, когда беда с управляющей базой, — а лента
    // аварий заведена файлом именно ради этого случая и от неё не зависит.
    // Экран с одной кнопкой «Повторить» отнимал бы у оператора и ленту, и выход
    // в единственный момент, ради которого они и нужны.
    const onLogs = vi.fn();
    const onStats = vi.fn();
    const api = adminApi({ overview: vi.fn().mockRejectedValue(new Error('control.db не читается')) });
    render(
      <AdminHomeScreen api={api} onSignedOut={vi.fn()} onLogs={onLogs} onStats={onStats} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('control.db не читается');
    fireEvent.click(screen.getByRole('button', { name: 'Аварии' }));
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Статистика' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });

  it('выходит по кнопке и оставляет экран, если выход не доехал', async () => {
    const onSignedOut = vi.fn();
    const api = adminApi({ logout: vi.fn().mockRejectedValue(new Error('Не получилось выйти')) });
    render(<AdminHomeScreen api={api} onSignedOut={onSignedOut} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));

    // Cookie оператора `HttpOnly`: до подтверждённого ответа сервера форма
    // входа была бы ложной — перезагрузка вернула бы живую сессию.
    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось выйти');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('сообщает наверх об удавшемся выходе', async () => {
    const onSignedOut = vi.fn();
    render(<AdminHomeScreen api={adminApi()} onSignedOut={onSignedOut} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });

  it('различает «ни разу», «занимался» и «выведен»', () => {
    const base = { childId: 'c', name: 'Кто-то', status: 'ready' as const, createdAt: '2026-08-01T09:00:00.000Z' };
    expect(childState(base)).toBe('Ни разу не занимался');
    expect(childState({ ...base, lastActivityAt: '2026-08-21T08:00:00.000Z' })).toMatch(/^Занимался /u);
    expect(childState({ ...base, retiredAt: '2026-08-21T08:00:00.000Z' })).toMatch(/^Выведен /u);
    expect(megabytes(1536 * 1024)).toBe('1.5 МБ');
  });
});

/** Заполнить форму входа и отправить её: этим начинается любой путь оператора. */
async function signIn(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Электронная почта'), {
    target: { value: 'operator@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'пароль-оператора-подлиннее' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('корень админки', () => {
  it('показывает вход, а не поломку, когда сессии оператора нет', async () => {
    const api = adminApi({
      overview: vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' })),
    });
    render(<AdminApp api={api} />);

    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument();
    // Первый заход на адрес админки — не «сессия закончилась»: её и не было.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('после входа показывает сводку, а по кнопке «Выйти» — вход без выдумок', async () => {
    const overviewCall = vi.fn()
      .mockRejectedValueOnce(new HttpError({ status: 401, message: 'Нужно войти' }))
      .mockResolvedValue(overview());
    render(<AdminApp api={adminApi({ overview: overviewCall })} />);

    await signIn();

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    expect(screen.getByText('operator@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument();
    // Оператор вышел сам: «сессия закончилась» здесь было бы сообщением о
    // поломке, которой не было.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('объясняет оборвавшуюся сессию, когда она была', async () => {
    const overviewCall = vi.fn()
      .mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' }));
    render(<AdminApp api={adminApi({ overview: overviewCall })} />);

    await signIn();

    // Форма ждёт не сама по себе: роль `status` есть и у «Загружаю сводку…»,
    // поэтому объяснение ищется текстом.
    expect(await screen.findByText('Сессия закончилась. Войдите заново.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument();
  });
});
