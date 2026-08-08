// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import './test-setup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('App', () => {
  it('подключён к общему прогону компонентных тестов', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App />);

    expect(screen.getByRole('link', { name: 'Эдукатор' })).toBeInTheDocument();
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

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Сначала познакомимся' }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Загрузка задания')).not.toBeInTheDocument();
  });

  it('маршрутизирует kind=boss отдельно от обычного забега и триажа', async () => {
    window.history.replaceState({}, '', '/?runId=7&kind=boss');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        name: 'Ученик',
        interests: [],
        examDate: null,
        partnerName: 'Кекс',
        introduction: 'Готовы.',
      }),
    })));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Пять подряд — и тема закрыта' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Подбираю задание…')).not.toBeInTheDocument();
  });

  it('открывает pathname /parents напрямую без query string и профайл-гейта', async () => {
    window.history.replaceState({}, '', '/parents');
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        generatedAt: '2026-08-08T12:00:00.000Z',
        window: { since: '2026-08-01T12:00:00.000Z', until: '2026-08-08T12:00:00.000Z' },
        forecasts: [],
        time: { plannedMinutes: 630, actualMinutes: 0, daily: [] },
        gaps: [], activity: [],
        flags: { threeFullDaysWithoutRun: false, forecastNotGrowing: [], reduceLoad: [] },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' }))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/parents');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Сначала познакомимся' })).not.toBeInTheDocument();
  });
});
