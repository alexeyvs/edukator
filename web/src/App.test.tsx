// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, ProfileGate } from './App';
import type { AuthApi, Principal } from './auth-api';
import { requestJson, SignedOutError } from './http';
import './test-setup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const CHILD: Principal = { kind: 'child', childId: 'c-1', name: 'Тимофей' };

/** Минимальная сводка: экран проверяется своими тестами, здесь важен только путь. */
const DASHBOARD = {
  generatedAt: '2026-08-08T12:00:00.000Z',
  computerAccess: {
    day: '2026-08-08', required: 3, completed: 1, remaining: 2,
    learning: { materialId: null, required: false, passed: false },
    automaticUnlocked: false, override: null, unlocked: false, configured: true,
  },
  window: { since: '2026-08-01T12:00:00.000Z', until: '2026-08-08T12:00:00.000Z' },
  forecasts: [],
  time: { plannedMinutes: 630, actualMinutes: 35, daily: [] },
  gaps: [],
  activity: [],
  flags: { threeFullDaysWithoutRun: false, forecastNotGrowing: [], reduceLoad: [] },
};

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(CHILD),
    login: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    switchPersona: vi.fn().mockResolvedValue(CHILD),
    ...overrides,
  };
}

describe('App', () => {
  it('подключён к общему прогону компонентных тестов', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App authApi={authApi({ me: vi.fn(() => new Promise<Principal>(() => undefined)) })} />);

    expect(screen.getByRole('link', { name: 'Эдукатор' })).toBeInTheDocument();
  });

  it('показывает вход, когда никто не вошёл', async () => {
    render(<App authApi={authApi({ me: vi.fn().mockResolvedValue({ kind: 'anonymous' }) })} />);

    expect(await screen.findByRole('heading', { name: 'Эдукатор' })).toBeInTheDocument();
    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument();
  });

  // Вход родителя на детской машине отвечает `parent`, но `me` затем сообщает
  // обе живые сессии и активную роль. Ответ входа не является этим состоянием.
  it('перечитывает предъявителя после входа, а не верит его ответу', async () => {
    const me = vi.fn()
      .mockResolvedValueOnce({ kind: 'anonymous' })
      .mockResolvedValue(CHILD);
    const api = authApi({ me });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App authApi={api} />);

    fireEvent.change(await screen.findByLabelText('Электронная почта'), {
      target: { value: 'parent@example.org' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'длинный-пароль' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('link', { name: 'Эдукатор' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Дети' })).not.toBeInTheDocument();
  });

  it('переводит вошедшего родителя к составу семьи, а не к занятию', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'parent@example.org', pinConfigured: false, children: [] }
        : { name: 'Тимофей', interests: [], examDate: null, partnerName: 'Кекс', introduction: 'Готовы.' }),
    })));
    render(<App authApi={authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    })} />);

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Сначала познакомимся' })).not.toBeInTheDocument();
  });

  it('явно переключает браузер с обеими сессиями в обе стороны', async () => {
    const both = {
      kind: 'both' as const,
      active: 'child' as 'parent' | 'child',
      parent: { email: 'parent@example.org' },
      child: { childId: 'c-1', name: 'Тимофей' },
    };
    const switchPersona = vi.fn((kind: 'parent' | 'child', _password?: string) => (
      kind === 'parent'
        ? Promise.resolve({ ...both, active: kind })
        : new Promise<typeof both>(() => undefined)
    ));
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'parent@example.org', pinConfigured: false, children: [] }
        : { name: 'Тимофей', interests: [], examDate: null, partnerName: 'Кекс', introduction: 'Готовы.' }),
    })));
    render(<App authApi={authApi({ me: vi.fn().mockResolvedValue(both), switchPersona })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к родителю' }));
    fireEvent.change(screen.getByLabelText('Пароль родителя'), { target: { value: 'пароль-подлиннее' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить вход родителя' }));
    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(switchPersona).toHaveBeenCalledWith('parent', 'пароль-подлиннее');

    fireEvent.click(screen.getByRole('button', { name: 'Перейти к ученику Тимофей' }));
    await waitFor(() => expect(switchPersona).toHaveBeenLastCalledWith('child'));
  });

  it('после отзыва активного детского устройства оставляет живую сессию родителя', async () => {
    const both = {
      kind: 'both' as const,
      active: 'child' as const,
      parent: { email: 'parent@example.org' },
      child: { childId: 'c-1', name: 'Тимофей' },
    };
    const me = vi.fn()
      .mockResolvedValueOnce(both)
      .mockResolvedValue({ kind: 'parent', email: 'parent@example.org' });
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: url !== '/expired',
      status: url === '/expired' ? 401 : 200,
      json: () => Promise.resolve(url === '/expired'
        ? { error: 'Нужно войти' }
        : url.startsWith('/api/family')
          ? { email: 'parent@example.org', pinConfigured: false, children: [] }
          : { name: 'Тимофей', interests: [], examDate: null, partnerName: '', introduction: 'Готовы.' }),
    })));
    render(<App authApi={authApi({ me })} />);
    expect(await screen.findByRole('button', { name: 'Перейти к родителю' })).toBeInTheDocument();

    await act(async () => {
      await expect(requestJson('/expired', undefined, 'Нужно войти')).rejects.toBeInstanceOf(SignedOutError);
    });

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('после окончания активной родительской сессии оставляет живое детское устройство', async () => {
    const both = {
      kind: 'both' as const,
      active: 'parent' as const,
      parent: { email: 'parent@example.org' },
      child: { childId: 'c-1', name: 'Тимофей' },
    };
    const me = vi.fn()
      .mockResolvedValueOnce(both)
      .mockResolvedValue({ kind: 'child', childId: 'c-1', name: 'Тимофей' });
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: url !== '/expired',
      status: url === '/expired' ? 401 : 200,
      json: () => Promise.resolve(url === '/expired'
        ? { error: 'Нужно войти' }
        : url.startsWith('/api/family')
          ? { email: 'parent@example.org', pinConfigured: false, children: [] }
          : { name: 'Тимофей', interests: [], examDate: null, partnerName: '', introduction: 'Готовы.' }),
    })));
    render(<App authApi={authApi({ me })} />);
    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();

    await act(async () => {
      await expect(requestJson('/expired', undefined, 'Нужно войти')).rejects.toBeInstanceOf(SignedOutError);
    });

    expect(await screen.findByRole('heading', { name: 'Сначала познакомимся' })).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('гасит детскую ссылку и убирает токен из адресной строки', async () => {
    window.history.replaceState({}, '', '/join/secret-token');
    const api = authApi();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App authApi={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    await waitFor(() => expect(api.claimDevice).toHaveBeenCalledWith('secret-token'));
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(api.me).toHaveBeenCalled());
  });

  it('называет причину, когда погашение прошло, а cookie браузер не принял', async () => {
    // По голому http на адрес вида `192.168.100.141:3000` браузер молча
    // выбрасывает cookie с префиксом `__Host-`. Ссылка при этом уже погашена
    // безвозвратно, и без объяснения ребёнок видит форму родительского входа,
    // пробует ссылку снова и получает то же самое.
    window.history.replaceState({}, '', '/join/secret-token');
    const api = authApi({ me: vi.fn().mockResolvedValue({ kind: 'anonymous' }) });
    render(<App authApi={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Это мой компьютер' }));
    await waitFor(() => expect(api.claimDevice).toHaveBeenCalledWith('secret-token'));
    expect(await screen.findByText(/браузер не принял cookie/u)).toBeInTheDocument();
  });

  it('не пишет про cookie тому, кто просто открыл страницу входа', async () => {
    const api = authApi({ me: vi.fn().mockResolvedValue({ kind: 'anonymous' }) });
    render(<App authApi={api} />);

    expect(await screen.findByLabelText('Электронная почта')).toBeInTheDocument();
    expect(screen.queryByText(/браузер не принял cookie/u)).not.toBeInTheDocument();
  });

  it('открывает установку пароля по родительскому приглашению и прячет токен', async () => {
    window.history.replaceState({}, '', '/invite/secret-token');
    const api = authApi();
    render(<App authApi={api} />);

    expect(await screen.findByRole('heading', { name: 'Придумайте пароль' })).toBeInTheDocument();
    expect(api.readInvite).toHaveBeenCalledWith('secret-token');
    expect(window.location.pathname).toBe('/');
    expect(api.me).not.toHaveBeenCalled();
  });

  it('после установки пароля показывает семью, а не ту же форму', async () => {
    window.history.replaceState({}, '', '/invite/secret-token');
    // Предъявитель перечитывается: ответ на установку пароля им не считается,
    // потому что в браузере ученика `me` должен сообщить обе живые сессии.
    const api = authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'parent@example.org', children: [] }),
    }));
    render(<App authApi={api} />);

    await screen.findByRole('heading', { name: 'Придумайте пароль' });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'пароль-подлиннее' } });
    fireEvent.change(screen.getByLabelText('Пароль ещё раз'), {
      target: { value: 'пароль-подлиннее' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль и войти' }));

    // Cookie уже выдана, а `link` проверяется раньше `principal`: не погасив
    // страницу ссылки, приложение оставило бы форму на экране, и вторая отправка
    // ушла бы в уже погашенный одноразовый токен.
    await waitFor(() => expect(api.redeemInvite).toHaveBeenCalledWith(
      'secret-token',
      'пароль-подлиннее',
    ));
    await waitFor(() => expect(api.me).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Придумайте пароль' })).not.toBeInTheDocument();
  });

  it('убирает токен из адресной строки заменой записи, а не новой', async () => {
    window.history.replaceState({}, '', '/join/secret-token');
    // Именно `replaceState`: `pushState` оставил бы адрес с токеном в истории
    // браузера, откуда его достаёт кнопка «назад».
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App authApi={authApi()} />);

    await waitFor(() => expect(replaceState).toHaveBeenCalledWith(null, '', '/'));
    expect(pushState).not.toHaveBeenCalled();
    replaceState.mockRestore();
    pushState.mockRestore();
  });

  it('возвращает ко входу, когда сессия родителя кончилась посреди экрана', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Нужно войти' }),
    }));
    // Предъявитель называется явно и дожидается экрана: текст зависит от того,
    // кого выбросило, и по умолчанию (`me` отдаёт ребёнка) выбор между двумя
    // сообщениями решала бы гонка `me` с самим 401.
    const api = authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    });
    // 401 приезжает первым же запросом «Семьи»: экран, на котором сессия
    // кончилась, здесь именно он.
    render(<App authApi={api} />);

    expect(await screen.findByText('Сессия закончилась. Войдите заново.')).toBeInTheDocument();
    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument();
  });

  // Ученику тот же экран предлагает сделать невозможное: пароля у него нет и
  // быть не должно, вернуть его может только новая ссылка от родителя.
  it('называет отозванное устройство ученика своим именем, а не концом сессии', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Нужно войти' }),
    }));
    // Ребёнку 401 приезжает первым же запросом занятия — тем самым, каким
    // экран проверяет профиль: доводить до него отдельный `requestJson` не
    // нужно, важен текст, с которым его выбросило.
    render(<App authApi={authApi()} />);

    expect(await screen.findByText(
      'Это устройство отключено. Попросите родителя выпустить новую ссылку.',
    )).toBeInTheDocument();
    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument();
  });

  it('называет агентский токен в браузере нерабочим состоянием', async () => {
    // Токен агента выдаётся контроллеру доступа, у которого интерфейса нет:
    // открытый им браузер обязан сказать это прямо, а не показывать занятие.
    const api = authApi({ me: vi.fn().mockResolvedValue({ kind: 'agent', childId: 'c-1' }) });
    render(<App authApi={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('подключено как контроллер доступа');
  });

  it('показывает поломку проверки входа, а не пустой экран', async () => {
    const api = authApi({ me: vi.fn().mockRejectedValue(new Error('Управляющая база недоступна')) });
    render(<App authApi={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Управляющая база недоступна');
  });

  it('даёт повторить проверку входа, а не запирает на поломке', async () => {
    // Обрыв сети на старте иначе оставлял бы «Failed to fetch» насовсем: эффект
    // второй раз не пойдёт, предъявитель так и остаётся `null`. Хуже всего это
    // ребёнку, который только что погасил свою одноразовую ссылку, — повторять
    // ему уже нечего.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'parent@example.org', pinConfigured: false, children: [] }),
    }));
    const me = vi.fn()
      .mockRejectedValueOnce(new Error('Управляющая база недоступна'))
      .mockResolvedValue({ kind: 'parent', email: 'parent@example.org' });
    render(<App authApi={authApi({ me })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Управляющая база недоступна');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('даёт ученику повторить чтение профиля', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('База ребёнка недоступна'))
      .mockResolvedValue({ name: 'Тимофей', partnerName: 'Напарник', interests: [], xp: 0 });
    render(<ProfileGate api={{ read, save: vi.fn() }}><p>Занятие</p></ProfileGate>);
    expect(await screen.findByRole('alert')).toHaveTextContent('База ребёнка недоступна');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Занятие')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('показывает вход, а не поломку, когда проверка входа отвечает 401', async () => {
    // 401 на `me` бывает у обратного прокси. Слушатель уже поставил
    // `anonymous`, а `problem` проверяется раньше него: без разбора
    // `SignedOutError` экран встал бы на красной надписи «Нужно войти» без
    // единой формы, и второй раз эффект не пошёл бы — предъявитель уже не `null`.
    const api = authApi({ me: vi.fn().mockRejectedValue(new SignedOutError()) });
    render(<App authApi={api} />);

    expect(await screen.findByLabelText('Электронная почта')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('на отказавшем выходе сохраняет сессию и даёт повторить', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'parent@example.org', pinConfigured: false, children: [] }),
    }));
    const rejections: unknown[] = [];
    const catcher = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      rejections.push(event.reason);
    };
    window.addEventListener('unhandledrejection', catcher);
    try {
      const api = authApi({
        me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
        logout: vi.fn().mockRejectedValue(new Error('Не получилось выйти')),
      });
      render(<App authApi={api} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));

      // Cookie `HttpOnly`, снять её умеет только сервер. До его ответа экран
      // входа ложно обещал бы выход: перезагрузка вернула бы живую сессию.
      expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось выйти');
      expect(screen.getByRole('heading', { name: 'Дети' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Повторить выход' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Электронная почта')).not.toBeInTheDocument();
      await act(async () => {
        await Promise.resolve();
      });
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', catcher);
    }
  });

  it('водит родителя между составом семьи, сводкой ребёнка и обратно', async () => {
    const family = {
      email: 'parent@example.org',
      pinConfigured: true,
      children: [
        { id: 'c-1', name: 'Тимофей', status: 'ready', createdAt: '2026-08-01T09:00:00.000Z', devices: [] },
        { id: 'c-2', name: 'Марта', status: 'ready', createdAt: '2026-08-01T09:00:00.000Z', devices: [] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family') ? family : DASHBOARD),
    })));
    const api = authApi({ me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }) });
    render(<App authApi={api} />);

    const card = await screen.findByRole('article', { name: 'Ребёнок: Марта' });
    fireEvent.click(within(card).getByRole('button', { name: 'Сводка' }));
    expect(await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' }))
      .toBeInTheDocument();

    // Переключатель показывает обоих детей: список приходит с экрана семьи.
    fireEvent.change(await screen.findByLabelText('Ребёнок'), { target: { value: 'c-1' } });
    await waitFor(() => expect(screen.getByLabelText('Ребёнок')).toHaveValue('c-1'));

    fireEvent.click(screen.getByRole('button', { name: 'К составу семьи' }));
    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
  });

  it('выводит родителя из учётной записи по кнопке', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'parent@example.org', pinConfigured: false, children: [] }),
    }));
    const api = authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    });
    render(<App authApi={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));

    await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText('Электронная почта')).toBeInTheDocument();
  });

  it('не даёт прямой ссылке на забег обойти первое знакомство', async () => {
    window.history.replaceState({}, '', '/?runId=7');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        name: 'Ученик',
        interests: [],
        examDate: null,
        partnerName: '',
        introduction: 'Давай познакомимся.',
      }),
    })));

    render(<App authApi={authApi()} />);

    expect(await screen.findByRole('heading', { name: 'Сначала познакомимся' }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Загрузка задания')).not.toBeInTheDocument();
  });

  it('маршрутизирует kind=boss отдельно от обычного забега и триажа', async () => {
    window.history.replaceState({}, '', '/?runId=7&kind=boss');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(input).includes('/api/boss/7/state') ? {
        outcome: 'active', progress: { total: 0, correct: 0, target: 5, done: false },
      } : {
        name: 'Ученик',
        interests: [],
        examDate: null,
        partnerName: 'Кекс',
        introduction: 'Готовы.',
      }),
    })));

    render(<App authApi={authApi()} />);

    expect(await screen.findByRole('heading', { name: 'Пять подряд — и тема закрыта' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Подбираю задание…')).not.toBeInTheDocument();
  });

  it('открывает персональный разбор по learningId через профайл-гейт', async () => {
    window.history.replaceState({}, '', '/?learningId=21');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(input).includes('/api/learning/21/open') ? {
        materialId: 21,
        resumed: true,
        material: {
          id: 21,
          subject: 'math',
          topic: { id: 'math.fractions', title: 'Обыкновенные дроби' },
          recommendationReason: 'Путаются знаменатели',
          estimatedMinutes: 12,
          passScore: 4,
          status: 'active',
          progress: { total: 0, correct: 0, target: 5, done: false },
          content: {
            introduction: 'Разберём дроби.',
            objectives: ['Складывать дроби'],
            sections: [
              { title: 'Части', blocks: [{ type: 'paragraph', content: 'У дроби две части.' }] },
              { title: 'Запись', blocks: [{ type: 'formula', content: '\\frac{a}{b}' }] },
              { title: 'Проверка', blocks: [{ type: 'example', content: 'Одна вторая.' }] },
            ],
            summary: ['Следи за знаменателем.', 'Проверяй ответ.'],
          },
        },
      } : {
        name: 'Ученик', interests: [], examDate: null, partnerName: 'Кекс', introduction: 'Готовы.',
      }),
    })));

    render(<App authApi={authApi()} />);

    expect(await screen.findByRole('heading', { name: 'Обыкновенные дроби', level: 1 }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Перейти к тесту' })).toBeInTheDocument();
  });

  it('держит полосу захода поверх настоящего детского экрана', async () => {
    // План занятия в этом тесте не приезжает: проверяется полоса поверх экрана,
    // а не сам экран, и своя выдумка плана разъехалась бы с его тестами.
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.startsWith('/api/profile')
      ? Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Тимофей', interests: [], examDate: null, partnerName: 'Кекс', introduction: 'Готовы.',
        }),
      })
      : new Promise(() => undefined))));

    render(<App authApi={authApi({
      me: vi.fn().mockResolvedValue({
        kind: 'child',
        childId: 'c-1',
        name: 'Тимофей',
        impersonation: {
          adminEmail: 'оператор@example.com',
          childName: 'Тимофей',
          role: 'browser',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      }),
    })} />);

    expect(await screen.findByRole('button', { name: 'Выйти в админку' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('оператор@example.com');
    // Экран остаётся настоящим: оператор пришёл смотреть ровно то, что видит
    // ученик, и подменённый полосой экран отвечал бы не на тот вопрос.
    expect(screen.getByRole('link', { name: 'Эдукатор' })).toBeInTheDocument();
  });

  it('держит полосу захода и поверх родительского экрана', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'чужой@example.org', pinConfigured: false, children: [] }
        : DASHBOARD),
    })));

    render(<App authApi={authApi({
      me: vi.fn().mockResolvedValue({
        kind: 'parent',
        email: 'чужой@example.org',
        impersonation: {
          adminEmail: 'оператор@example.com',
          childName: 'Тимофей',
          role: 'parent',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      }),
    })} />);

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('как родитель');
    // «Выйти» под заходом не предлагается вовсе: он читает **собственную**
    // cookie оператора, гасит его же родительскую сессию и уводит корень на
    // экран входа — вместе с несъёмной полосой, то есть с единственной кнопкой
    // возврата в админку.
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Выйти в админку' })).toBeInTheDocument();
  });

  /** Ответ `me` для семьи под заходом; `expiresAt` уже в прошлом. */
  function expiredImpersonation(): Principal {
    return {
      kind: 'parent',
      email: 'чужой@example.org',
      impersonation: {
        adminEmail: 'оператор@example.com',
        childName: 'Тимофей',
        role: 'parent',
        expiresAt: '2026-08-21T09:00:00.000Z',
      },
    };
  }

  it('на кончившемся заходе показывает его конец вместо экранов семьи', async () => {
    // Сервер срок кончает молча: просроченную строку `resolveImpersonation` уже
    // не отдаёт, и разбор предъявителя падает на **собственные** cookie
    // оператора — они живы, машина его. Экраны семьи с этого мгновения
    // показывают его семью, а полоса поверх них называла бы чужую: подпись
    // кадра оказалась бы ложной ровно там, где заводилась ради правды.
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'чужой@example.org', pinConfigured: false, children: [] }
        : DASHBOARD),
    })));

    const me = vi.fn()
      .mockResolvedValueOnce(expiredImpersonation())
      // Переспрос: заход кончился, и сервер отвечает уже собственным
      // предъявителем оператора.
      .mockResolvedValue({ kind: 'parent', email: 'свой@example.org' });

    render(<App authApi={authApi({ me })} now={() => Date.parse('2026-08-21T09:00:01.000Z')} />);

    expect(await screen.findByText(/Срок захода в семью вышел/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вернуться в админку' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Дети' })).toBeNull();
    expect(screen.queryByText(/Чужая семья/u)).toBeNull();
  });

  it('не выгоняет из живого захода по разошедшимся часам оператора', async () => {
    // `expiresAt` считал сервер, а часы машины оператора могут спешить.
    // Поверив им, экран закрывал бы работающий заход по чужому расхождению,
    // поэтому истёкший здесь срок означает «переспроси», а не «конец».
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'чужой@example.org', pinConfigured: false, children: [] }
        : DASHBOARD),
    })));

    // Сервер обоими ответами подтверждает: заход жив.
    const me = vi.fn().mockResolvedValue(expiredImpersonation());

    render(<App authApi={authApi({ me })} now={() => Date.parse('2026-08-21T09:00:01.000Z')} />);

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.getByText(/Чужая семья/u)).toBeInTheDocument();
    expect(screen.queryByText(/Срок захода в семью вышел/u)).toBeNull();
  });

  it('спрашивает сервер и до срока: отставшие часы оператора решать не должны', async () => {
    // Часы машины оператора могут отставать сколько угодно, а `expiresAt`
    // считал сервер. Спрашивать только по достижении срока значило бы отдать
    // решение именно им: до `expiresAt` отставшие часы не доходят вовсе, и
    // чужая семья оставалась бы на экране после конца пятнадцати минут — ровно
    // тот случай, ради которого срок и заведён.
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'чужой@example.org', pinConfigured: false, children: [] }
        : DASHBOARD),
    })));

    const living: Principal = {
      kind: 'parent',
      email: 'чужой@example.org',
      impersonation: {
        adminEmail: 'оператор@example.com',
        childName: 'Тимофей',
        role: 'parent',
        // По здешним часам до конца захода ещё пятнадцать минут.
        expiresAt: '2026-08-21T09:15:00.000Z',
      },
    };
    const me = vi.fn()
      .mockResolvedValueOnce(living)
      // Сервер уже считает заход кончившимся: его часы шли вперёд наших.
      .mockResolvedValue({ kind: 'parent', email: 'свой@example.org' });

    render(<App authApi={authApi({ me })} now={() => Date.parse('2026-08-21T09:00:00.000Z')} />);

    expect(await screen.findByText(/Срок захода в семью вышел/u)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Дети' })).toBeNull();
  });

  it('не наслаивает проверки срока, пока предыдущая не ответила', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.startsWith('/api/family')
          ? { email: 'чужой@example.org', pinConfigured: false, children: [] }
          : DASHBOARD),
      })));
      const living = expiredImpersonation();
      const pending = new Promise<Principal>(() => undefined);
      const me = vi.fn()
        .mockResolvedValueOnce(living)
        .mockImplementation(() => pending);

      render(<App authApi={authApi({ me })} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 30_000); });

      // Первый вызов загружает предъявителя, второй стережёт срок. Следующие
      // тики не заводят новые запросы, пока второй не закончен.
      expect(me).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('оставляет «Выйти» родителю без захода', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.startsWith('/api/family')
        ? { email: 'свой@example.org', pinConfigured: false, children: [] }
        : DASHBOARD),
    })));

    render(<App authApi={authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'свой@example.org' }),
    })} />);

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });

  it('не рисует полосы там, где захода нет', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.startsWith('/api/profile')
      ? Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Тимофей', interests: [], examDate: null, partnerName: 'Кекс', introduction: 'Готовы.',
        }),
      })
      : new Promise(() => undefined))));

    render(<App authApi={authApi()} />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Эдукатор' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Выйти в админку' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('отдаёт адрес /admin админке и не спрашивает у сервера детского предъявителя', async () => {
    window.history.replaceState({}, '', '/admin');
    // Сводка оператора отвечает 401: живость его сессии показывает первый же
    // запрос за данными, и админка переходит ко входу сама.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unauthorized' }),
    })));
    const me = vi.fn().mockResolvedValue(CHILD);

    render(<App authApi={authApi({ me })} />);

    expect(await screen.findByText('Вход оператора')).toBeInTheDocument();
    expect(me).not.toHaveBeenCalled();
  });

  it('открывает pathname /parents ученику со сводкой его собственного ребёнка', async () => {
    window.history.replaceState({}, '', '/parents');
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        generatedAt: '2026-08-08T12:00:00.000Z',
        computerAccess: {
          day: '2026-08-08', required: 3, completed: 0, remaining: 3,
          learning: { materialId: null, required: false, passed: false },
          automaticUnlocked: false, override: null, unlocked: false, configured: false,
        },
        window: { since: '2026-08-01T12:00:00.000Z', until: '2026-08-08T12:00:00.000Z' },
        forecasts: [],
        time: { plannedMinutes: 630, actualMinutes: 0, daily: [] },
        gaps: [], activity: [],
        flags: { threeFullDaysWithoutRun: false, forecastNotGrowing: [], reduceLoad: [] },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App authApi={authApi()} />);

    expect(await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' }))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/parents/c-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Сначала познакомимся' })).not.toBeInTheDocument();
    // PIN у детской машины спрашивается: вошедшего родителя за ней нет.
    expect(screen.getByText('PIN родителя не настроен. Управление доступом отключено.'))
      .toBeInTheDocument();
  });
});
