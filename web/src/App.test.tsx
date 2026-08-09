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

    render(<App />);

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

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Обыкновенные дроби', level: 1 }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Перейти к тесту' })).toBeInTheDocument();
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
