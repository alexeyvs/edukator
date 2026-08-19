// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, readLinkPage } from './App';
import type { AuthApi, Principal } from './auth-api';
import { requestJson } from './http';
import './test-setup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const CHILD: Principal = { kind: 'child', childId: 'c-1', name: 'Тимофей' };

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(CHILD),
    login: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    logout: vi.fn().mockResolvedValue(undefined),
    readInvite: vi.fn().mockResolvedValue({ email: 'parent@example.org' }),
    redeemInvite: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    claimDevice: vi.fn().mockResolvedValue({ kind: 'child', childId: 'c-1' }),
    ...overrides,
  };
}

describe('разбор страницы по ссылке', () => {
  it('узнаёт приглашение и погашение, но не пустой и не составной токен', () => {
    expect(readLinkPage('/invite/abc')).toEqual({ kind: 'invite', token: 'abc' });
    expect(readLinkPage('/join/abc')).toEqual({ kind: 'join', token: 'abc' });
    expect(readLinkPage('/join/')).toBeNull();
    expect(readLinkPage('/join/a/b')).toBeNull();
    expect(readLinkPage('/parents')).toBeNull();
  });
});

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

  it('переводит вошедшего родителя к составу семьи, а не к занятию', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'parent@example.org', pinConfigured: false, children: [] }),
    }));
    render(<App authApi={authApi({
      me: vi.fn().mockResolvedValue({ kind: 'parent', email: 'parent@example.org' }),
    })} />);

    expect(await screen.findByRole('heading', { name: 'Дети' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Сначала познакомимся' })).not.toBeInTheDocument();
  });

  it('гасит детскую ссылку и убирает токен из адресной строки', async () => {
    window.history.replaceState({}, '', '/join/secret-token');
    const api = authApi();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App authApi={api} />);

    await waitFor(() => expect(api.claimDevice).toHaveBeenCalledWith('secret-token'));
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(api.me).toHaveBeenCalled());
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

  it('возвращает ко входу, когда сессия кончилась посреди экрана', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Нужно войти' }),
    }));
    render(<App authApi={authApi()} />);
    await screen.findByRole('status');

    await act(async () => {
      await requestJson('/api/run/plan', undefined, 'Не получилось загрузить план')
        .catch(() => undefined);
    });

    expect(await screen.findByText('Сессия закончилась. Войдите заново.')).toBeInTheDocument();
    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument();
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
