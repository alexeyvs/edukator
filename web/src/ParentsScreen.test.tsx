// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParentsScreen } from './ParentsScreen';
import type { ParentsApi, ParentsDashboard } from './parents-api';
import './test-setup';

afterEach(cleanup);

const DASHBOARD: ParentsDashboard = {
  generatedAt: '2026-08-08T12:00:00.000Z',
  window: { since: '2026-08-01T12:00:00.000Z', until: '2026-08-08T12:00:00.000Z' },
  forecasts: [
    { subject: 'math', score: 4.1, band: 0.3, low: 3.8, high: 4.4, preliminary: false, delta: 0.4 },
    { subject: 'russian', score: 3.2, band: 0.8, low: 2.4, high: 4, preliminary: true, delta: -0.1 },
    { subject: 'english', score: 3.6, band: 0.5, low: 3.1, high: 4.1, preliminary: false },
  ],
  time: {
    plannedMinutes: 630,
    actualMinutes: 35,
    daily: [
      { date: '2026-08-01', minutes: 4 },
      { date: '2026-08-02', minutes: 6 },
      { date: '2026-08-08', minutes: 25 },
    ],
  },
  gaps: [
    { title: 'Слитное и раздельное написание НЕ', subject: 'russian' },
    { title: 'Обыкновенные дроби', subject: 'math' },
  ],
  activity: [
    { kind: 'lesson', subject: 'math', startedAt: '2026-08-08T10:00:00.000Z', finishedAt: '2026-08-08T10:08:00.000Z', total: 5, correct: 4, activeMinutes: 6 },
    { kind: 'run', subject: 'math', startedAt: '2026-08-08T09:00:00.000Z', finishedAt: '2026-08-08T09:15:00.000Z', total: 5, correct: 4, activeMinutes: 12 },
    { kind: 'triage', subject: 'english', startedAt: '2026-08-07T09:00:00.000Z', finishedAt: '2026-08-07T09:10:00.000Z', total: 4, correct: 2, activeMinutes: 8 },
    { kind: 'boss', subject: 'russian', startedAt: '2026-08-06T09:00:00.000Z', finishedAt: '2026-08-06T09:10:00.000Z', total: 5, correct: 5, activeMinutes: 9, bossOutcome: 'won' },
  ],
  flags: { threeFullDaysWithoutRun: true, forecastNotGrowing: ['russian'], reduceLoad: ['math'] },
};

function parentsApi(value: ParentsDashboard = DASHBOARD): ParentsApi {
  return { read: vi.fn().mockResolvedValue(value) };
}

describe('родительский дашборд', () => {
  it('показывает прогнозы, честное время, семь дней, темы, типы забегов и наблюдения', async () => {
    const { container } = render(<ParentsScreen api={parentsApi()} />);

    expect(await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' })).toBeInTheDocument();
    const forecasts = screen.getByRole('region', { name: 'По предметам' });
    expect(within(forecasts).getAllByRole('article')).toHaveLength(3);
    expect(forecasts).toHaveTextContent('4.1 ± 0.3');
    expect(forecasts).toHaveTextContent('Диапазон 3.8–4.4');
    expect(forecasts).toHaveTextContent('За 7 дней: +0.4');
    expect(forecasts).toHaveTextContent('За 7 дней: -0.1');
    expect(forecasts).toHaveTextContent('нет точки сравнения');
    expect(forecasts).toHaveTextContent('Предварительный прогноз: данных пока мало');

    expect(screen.getByRole('region', { name: 'План и факт' })).toHaveTextContent('План630 минФакт35 мин');
    const bars = screen.getByLabelText('Активное время по дням');
    expect(within(bars).getAllByRole('time')).toHaveLength(7);
    const minutes = [...bars.querySelectorAll('.parents-bar-value')]
      .map((item) => Number(item.textContent));
    expect(minutes.reduce((sum, value) => sum + value, 0)).toBe(DASHBOARD.time.actualMinutes);
    expect(minutes[0]).toBe(10);

    expect(screen.getByRole('region', { name: 'Что пока даётся труднее' }))
      .toHaveTextContent('Слитное и раздельное написание НЕ');
    const activity = screen.getByRole('region', { name: 'Лента забегов' });
    expect(activity).toHaveTextContent('Обычный забег');
    expect(activity).toHaveTextContent('Триаж');
    expect(activity).toHaveTextContent('Босс');
    expect(activity).toHaveTextContent('Тест по разбору');
    expect(activity).toHaveTextContent('победа');
    expect(screen.getByRole('region', { name: 'На что обратить внимание' }))
      .toHaveTextContent('Три полных дня без обычных забегов');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container).not.toHaveTextContent('internal-secret');
  });

  it('спокойно показывает пустую историю, темы и наблюдения', async () => {
    render(<ParentsScreen api={parentsApi({
      ...DASHBOARD,
      gaps: [],
      activity: [],
      flags: { threeFullDaysWithoutRun: false, forecastNotGrowing: [], reduceLoad: [] },
    })} />);

    expect(await screen.findByText('За эту неделю завершённых забегов пока нет.')).toBeInTheDocument();
    expect(screen.getByText('Проблемные темы пока не определились.')).toBeInTheDocument();
    expect(screen.getByText('За неделю нет наблюдений, требующих внимания.')).toBeInTheDocument();
  });

  it('показывает отказ загрузки и использует read-only API', async () => {
    const api = parentsApi();
    vi.mocked(api.read).mockRejectedValue(new Error('Дашборд временно недоступен'));
    render(<ParentsScreen api={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Дашборд временно недоступен');
    await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
