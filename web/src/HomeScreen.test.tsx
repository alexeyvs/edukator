// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import type { DayPlanResponse, HomeApi } from './home-api';
import type { FinishRunResponse } from './run-api';
import './test-setup';

afterEach(cleanup);

const PLAN: DayPlanResponse = {
  plan: [
    { subject: 'math', topic: { id: 'math.fractions', title: 'Обыкновенные дроби' }, priority: 1, triagePassed: true },
    { subject: 'russian', topic: { id: 'russian.vowels', title: 'Безударные гласные' }, priority: 2, triagePassed: false },
  ],
  forecasts: [
    { subject: 'math', score: 3.5, band: .4, low: 3.1, high: 3.9 },
    { subject: 'russian', score: 4, band: .3, low: 3.7, high: 4.3 },
    { subject: 'english', score: 2.5, band: .5, low: 2, high: 3 },
  ],
  triage: [
    { subject: 'math', passed: true },
    { subject: 'russian', passed: false },
    { subject: 'english', passed: false },
  ],
};

function apiWith(plan: DayPlanResponse): HomeApi {
  return {
    plan: vi.fn().mockResolvedValue(plan),
    profile: vi.fn().mockResolvedValue({ examDate: '2026-08-18' }),
    start: vi.fn().mockResolvedValue({
      runId: 7,
      resumed: false,
      progress: { total: 0, correct: 0, target: 12, done: false },
    }),
    startTriage: vi.fn().mockResolvedValue({
      runId: 8,
      resumed: false,
      progress: { total: 0, correct: 0, target: 12, done: false },
    }),
    finish: vi.fn(),
  };
}

describe('главный экран', () => {
  it('до первого триажа показывает только его, после — план дня', async () => {
    const before = apiWith({
      ...PLAN,
      triage: PLAN.triage.map((item) => ({ ...item, passed: false })),
    });
    const view = render(<HomeScreen api={before} now={() => new Date('2026-08-08T12:00:00Z')} />);

    expect(await screen.findByRole('button', { name: 'Пройти триаж' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Начать' })).not.toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();

    view.unmount();
    render(<HomeScreen api={apiWith(PLAN)} />);

    expect(await screen.findByRole('heading', { name: 'Забеги на сегодня' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Начать' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Пройти триаж · Русский язык' })).toBeInTheDocument();
    expect(screen.getByText('3.5')).toBeInTheDocument();
    expect(screen.getByText('4.0')).toBeInTheDocument();
  });

  it('пустой план дня даёт явное завершённое состояние', async () => {
    render(<HomeScreen api={apiWith({ ...PLAN, plan: [] })} />);

    expect(await screen.findByText('На сегодня всё закрыто')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Начать' })).not.toBeInTheDocument();
  });

  it('ведёт на финал, если подхваченный забег уже достиг цели', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.start).mockResolvedValue({
      runId: 7,
      resumed: true,
      progress: { total: 12, correct: 9, target: 12, done: true },
    });
    const summary: FinishRunResponse = {
      runId: 7,
      total: 12,
      correct: 9,
      xp: 180,
      touchedTopics: [],
      closedTopics: [],
      declinedTopics: [],
      forecast: { id: 1, subject: 'math', score: 4, band: .3, createdAt: '2026-08-08T12:00:00Z' },
    };
    vi.mocked(api.finish).mockResolvedValue(summary);
    const navigate = vi.fn();
    render(<HomeScreen api={api} navigate={navigate} />);

    fireEvent.click(await screen.findAllByRole('button', { name: 'Начать' }).then((items) => items[0]!));

    expect(await screen.findByText('Забег завершён')).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(7);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('показывает ошибку старта и оставляет экран доступным', async () => {
    const api = apiWith(PLAN);
    vi.mocked(api.start).mockRejectedValue(new Error('Забег временно недоступен'));
    render(<HomeScreen api={api} />);

    fireEvent.click(await screen.findAllByRole('button', { name: 'Начать' }).then((items) => items[0]!));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Забег временно недоступен'));
    expect(screen.getAllByRole('button', { name: 'Начать' })[0]).toBeEnabled();
  });
});
