// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParentsScreen } from './ParentsScreen';
import {
  ComputerAccessError,
  type ParentsApi,
  type ParentsDashboard,
  type ParentsRunDetail,
} from './parents-api';
import './test-setup';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DASHBOARD: ParentsDashboard = {
  generatedAt: '2026-08-08T12:00:00.000Z',
  computerAccess: {
    day: '2026-08-08', required: 3, completed: 1, remaining: 2,
    learning: { materialId: null, required: false, passed: false },
    automaticUnlocked: false, override: null, unlocked: false, configured: true,
  },
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
    { runId: 4, kind: 'lesson', subject: 'math', startedAt: '2026-08-08T10:00:00.000Z', finishedAt: '2026-08-08T10:08:00.000Z', total: 5, correct: 4, activeMinutes: 6 },
    { runId: 3, kind: 'run', subject: 'math', startedAt: '2026-08-08T09:00:00.000Z', finishedAt: '2026-08-08T09:15:00.000Z', total: 5, correct: 4, activeMinutes: 12 },
    { runId: 2, kind: 'triage', subject: 'english', startedAt: '2026-08-07T09:00:00.000Z', finishedAt: '2026-08-07T09:10:00.000Z', total: 4, correct: 2, activeMinutes: 8 },
    { runId: 1, kind: 'boss', subject: 'russian', startedAt: '2026-08-06T09:00:00.000Z', finishedAt: '2026-08-06T09:10:00.000Z', total: 5, correct: 5, activeMinutes: 9, bossOutcome: 'won' },
  ],
  flags: { threeFullDaysWithoutRun: true, forecastNotGrowing: ['russian'], reduceLoad: ['math'] },
};

const RUN_DETAIL: ParentsRunDetail = {
  runId: 4,
  kind: 'lesson',
  subject: 'math',
  startedAt: '2026-08-08T10:00:00.000Z',
  finishedAt: '2026-08-08T10:08:00.000Z',
  total: 5,
  correct: 4,
  activeMilliseconds: 96_000,
  attempts: [
    {
      number: 1,
      topicTitle: 'Обыкновенные дроби',
      answerFormat: 'choice',
      question: 'Какая дробь больше?',
      instruction: 'Выбери большую дробь',
      material: '\\frac{2}{3} \\quad \\frac{3}{5}',
      materialFormat: 'math',
      choices: ['2/3', '3/5'],
      studentAnswer: '3/5',
      correctAnswer: '2/3',
      explanation: String.raw`Приведи дроби к общему знаменателю: \(\frac{2}{3}>\frac{3}{5}\).`,
      hint: 'Сравни через общий знаменатель.',
      correct: false,
      correction: false,
      durationMilliseconds: 61_000,
      answeredAt: '2026-08-08T10:02:00.000Z',
    },
    {
      number: 2,
      topicTitle: 'Обыкновенные дроби',
      answerFormat: 'choice',
      question: 'Какая дробь больше?',
      instruction: 'Выбери большую дробь',
      material: '\\frac{2}{3} \\quad \\frac{3}{5}',
      materialFormat: 'math',
      choices: ['2/3', '3/5'],
      studentAnswer: '2/3',
      correctAnswer: '2/3',
      explanation: String.raw`Приведи дроби к общему знаменателю: \(\frac{2}{3}>\frac{3}{5}\).`,
      correct: true,
      correction: true,
      durationMilliseconds: 35_000,
      answeredAt: '2026-08-08T10:03:00.000Z',
    },
  ],
};

function parentsApi(value: ParentsDashboard = DASHBOARD, detail: ParentsRunDetail = RUN_DETAIL): ParentsApi {
  return {
    read: vi.fn().mockResolvedValue(value),
    readRun: vi.fn().mockResolvedValue(detail),
    approveIntegrity: vi.fn().mockResolvedValue({ status: 'completed', result: {} }),
    changeComputerAccess: vi.fn().mockImplementation(async (mode) => ({
      ...value.computerAccess,
      override: mode === 'automatic' ? null : {
        mode,
        changedAt: '2099-08-08T12:00:00.000Z',
        expiresAt: '2099-08-08T21:00:00.000Z',
      },
      unlocked: mode === 'unlocked',
    })),
  };
}

describe('родительский дашборд', () => {
  it('показывает прогнозы, честное время, семь дней, темы, типы забегов и наблюдения', async () => {
    const { container } = render(<ParentsScreen childId="c-1" api={parentsApi()} />);

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
    expect(container.querySelectorAll('.access-mode-control button')).toHaveLength(3);
    expect(container).not.toHaveTextContent('internal-secret');
  });

  it('лениво раскрывает вопросы, ответы, исправления, объяснения и время занятия', async () => {
    const api = parentsApi();
    const { container } = render(<ParentsScreen childId="c-1" api={api} />);

    const toggle = await screen.findByRole('button', { name: /Тест по разбору/u });
    expect(api.readRun).not.toHaveBeenCalled();
    fireEvent.click(toggle);

    expect(await screen.findByText('1 мин 36 сек')).toBeInTheDocument();
    expect(api.readRun).toHaveBeenCalledWith(4);
    expect(screen.getAllByText('Выбери большую дробь')).toHaveLength(2);
    expect(screen.getByText('3/5', { selector: '.parents-answer-comparison strong' })).toBeInTheDocument();
    expect(screen.getAllByText('2/3', { selector: '.parents-answer-comparison strong' })).toHaveLength(3);
    expect(screen.getByText('Исправление')).toBeInTheDocument();
    expect(screen.getByText('1 мин 1 сек')).toBeInTheDocument();
    expect(screen.getByText('35 сек')).toBeInTheDocument();
    expect(screen.getByText('Использована подсказка')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('Показать объяснение')[0] as HTMLElement);
    expect(container.querySelectorAll('.parents-attempt-explanation .katex')).toHaveLength(2);
    expect(container.querySelector('.parents-attempt-explanation .safe-rich-text'))
      .toHaveTextContent('Приведи дроби к общему знаменателю');

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(api.readRun).toHaveBeenCalledTimes(1);
  });

  it('ставит непрерывный переключатель сразу после intro и показывает автоматический режим', async () => {
    const { container } = render(<ParentsScreen childId="c-1" api={parentsApi()} />);

    const intro = await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' });
    const panel = screen.getByRole('region', { name: 'Компьютер заблокирован' });
    expect(intro.closest('section')?.nextElementSibling).toBe(panel);
    expect(panel).toHaveTextContent('Режим по плану');
    expect(panel).toHaveTextContent('Доступ откроется после выполнения условий дневного плана.');
    const control = within(panel).getByRole('group', { name: 'Режим доступа к компьютеру' });
    expect(within(control).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['По плану', 'Заблокировать', 'Разблокировать']);
    expect(within(control).getByRole('button', { name: 'По плану' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.parents-access-temporary')).toBeNull();
  });

  it.each([
    ['blocked', 'Компьютер заблокирован', 'Заблокировать'],
    ['unlocked', 'Компьютер разблокирован', 'Разблокировать'],
  ] as const)('показывает временный режим %s и точный срок', async (mode, title, buttonName) => {
    render(<ParentsScreen childId="c-1" api={parentsApi({
      ...DASHBOARD,
      computerAccess: {
        ...DASHBOARD.computerAccess,
        override: {
          mode,
          changedAt: '2099-08-08T12:00:00.000Z',
          expiresAt: '2099-08-08T21:00:00.000Z',
        },
        unlocked: mode === 'unlocked',
      },
    })} />);

    const panel = await screen.findByRole('region', { name: title });
    expect(panel).toHaveClass('parents-access-temporary');
    expect(panel).toHaveTextContent('Временный режим');
    expect(panel).toHaveTextContent(/До 9 августа.*00:00/u);
    expect(within(panel).getByRole('button', { name: buttonName })).toHaveAttribute('aria-pressed', 'true');
  });

  it('по expiresAt перечитывает новый день вместо вчерашнего automaticUnlocked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T20:59:59.000Z'));
    const expiredDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: {
        ...DASHBOARD.computerAccess,
        automaticUnlocked: true,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-08T20:50:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: true,
      },
    };
    const freshDashboard: ParentsDashboard = {
      ...DASHBOARD,
      generatedAt: '2026-08-08T21:00:00.000Z',
      computerAccess: {
        ...DASHBOARD.computerAccess,
        day: '2026-08-09',
        automaticUnlocked: false,
        override: null,
        unlocked: false,
      },
    };
    const api = parentsApi(expiredDashboard);
    vi.mocked(api.read)
      .mockResolvedValueOnce(expiredDashboard)
      .mockResolvedValueOnce(freshDashboard);
    await act(async () => { render(<ParentsScreen childId="c-1" api={api} />); });

    expect(screen.getByRole('region', { name: 'Компьютер разблокирован' }))
      .toHaveTextContent('Временный режим');
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(api.read).toHaveBeenCalledTimes(2);
    const panel = screen.getByRole('region', { name: 'Компьютер заблокирован' });
    expect(panel).toHaveTextContent('Режим по плану');
    expect(panel).not.toHaveClass('parents-access-temporary');
    fireEvent.change(within(panel).getByLabelText(/PIN родителя/u), { target: { value: '123456' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Разблокировать' }));
    expect(screen.getByRole('dialog', { name: 'Временно разблокировать компьютер?' }))
      .toBeInTheDocument();
  });

  it('на время expiry-refresh не показывает stale automatic и блокирует гонку команд', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T20:59:59.000Z'));
    const expiredDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: {
        ...DASHBOARD.computerAccess,
        automaticUnlocked: true,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-08T20:50:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: true,
      },
    };
    let resolveRefresh!: (value: ParentsDashboard) => void;
    const api = parentsApi(expiredDashboard);
    vi.mocked(api.read)
      .mockResolvedValueOnce(expiredDashboard)
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    await act(async () => { render(<ParentsScreen childId="c-1" api={api} />); });

    await act(async () => { vi.advanceTimersByTime(1_000); });

    const panel = screen.getByRole('region', { name: 'Проверяю доступ к компьютеру' });
    expect(panel).not.toHaveTextContent('Компьютер разблокирован');
    expect(within(panel).getAllByRole('button')
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: 'Заблокировать' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => {
      resolveRefresh({
        ...DASHBOARD,
        computerAccess: { ...DASHBOARD.computerAccess, day: '2026-08-09' },
      });
      await Promise.resolve();
    });
    expect(screen.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toHaveTextContent('Режим по плану');
  });

  it('после transient expiry-refresh error повторяет запрос с backoff без busy loop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T20:59:59.000Z'));
    const expiredDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: {
        ...DASHBOARD.computerAccess,
        automaticUnlocked: true,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-08T20:50:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: true,
      },
    };
    const freshDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: { ...DASHBOARD.computerAccess, day: '2026-08-09' },
    };
    const api = parentsApi(expiredDashboard);
    vi.mocked(api.read)
      .mockResolvedValueOnce(expiredDashboard)
      .mockRejectedValueOnce(new Error('Временная ошибка сети'))
      .mockResolvedValueOnce(freshDashboard);
    await act(async () => { render(<ParentsScreen childId="c-1" api={api} />); });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Временная ошибка сети');
    expect(screen.getByRole('region', { name: 'Состояние доступа неизвестно' }))
      .not.toHaveTextContent('Компьютер разблокирован');

    await act(async () => { vi.advanceTimersByTime(999); });
    expect(api.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(api.read).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toHaveTextContent('Режим по плану');
  });

  it('при clock skew повторяет same expired override с backoff, а не setTimeout zero loop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T20:59:59.000Z'));
    const expiredDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: {
        ...DASHBOARD.computerAccess,
        automaticUnlocked: true,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-08T20:50:00.000Z',
          expiresAt: '2026-08-08T21:00:00.000Z',
        },
        unlocked: true,
      },
    };
    const freshDashboard: ParentsDashboard = {
      ...DASHBOARD,
      computerAccess: { ...DASHBOARD.computerAccess, day: '2026-08-09' },
    };
    const api = parentsApi(expiredDashboard);
    vi.mocked(api.read)
      .mockResolvedValueOnce(expiredDashboard)
      .mockResolvedValueOnce(expiredDashboard)
      .mockResolvedValueOnce(freshDashboard);
    await act(async () => { render(<ParentsScreen childId="c-1" api={api} />); });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('region', { name: 'Состояние доступа неизвестно' }))
      .toHaveTextContent('Сервер ещё подтверждает прежний режим');

    await act(async () => { vi.advanceTimersByTime(999); });
    expect(api.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(api.read).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('region', { name: 'Компьютер заблокирован' }))
      .toHaveTextContent('Режим по плану');
  });

  it('подтверждает каждую смену отдельно и переиспользует PIN этой вкладки', async () => {
    const api = parentsApi();
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(<ParentsScreen childId="c-1" api={api} />);
    const pin = await screen.findByLabelText(/PIN родителя/u);
    fireEvent.change(pin, { target: { value: '123456' } });

    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }));
    let dialog = screen.getByRole('dialog', { name: 'Временно заблокировать компьютер?' });
    expect(dialog).toHaveTextContent('Команда действует до следующей московской полуночи.');
    expect(api.changeComputerAccess).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Заблокировать' }));
    await waitFor(() => expect(api.changeComputerAccess).toHaveBeenNthCalledWith(1, 'blocked', '123456'));
    expect(await screen.findByRole('status')).toHaveTextContent('Режим доступа обновлён.');

    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));
    dialog = screen.getByRole('dialog', { name: 'Временно разблокировать компьютер?' });
    expect(dialog).toHaveTextContent('Учебный план при этом не меняется.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Разблокировать' }));
    await waitFor(() => expect(api.changeComputerAccess).toHaveBeenNthCalledWith(2, 'unlocked', '123456'));

    fireEvent.click(screen.getByRole('button', { name: 'По плану' }));
    dialog = screen.getByRole('dialog', { name: 'Вернуть режим «По плану»?' });
    expect(dialog).toHaveTextContent('Доступ снова будет зависеть от дневного плана.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вернуть режим «По плану»' }));
    await waitFor(() => expect(api.changeComputerAccess).toHaveBeenNthCalledWith(3, 'automatic', '123456'));
    expect(pin).toHaveValue('123456');
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it('не отправляет команду без корректного PIN', async () => {
    const api = parentsApi();
    render(<ParentsScreen childId="c-1" api={api} />);
    fireEvent.change(await screen.findByLabelText(/PIN родителя/u), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Введите PIN родителя из 6–12 цифр.');
    expect(within(dialog).getByRole('button', { name: 'Заблокировать' })).toBeDisabled();
    expect(api.changeComputerAccess).not.toHaveBeenCalled();
  });

  it('очищает PIN после 401 и сохраняет его после остальных ошибок', async () => {
    const api = parentsApi();
    vi.mocked(api.changeComputerAccess)
      .mockRejectedValueOnce(new ComputerAccessError('Неверный PIN родителя', 401))
      .mockRejectedValueOnce(new ComputerAccessError('Сервис временно недоступен', 503));
    render(<ParentsScreen childId="c-1" api={api} />);
    const pin = await screen.findByLabelText(/PIN родителя/u);
    fireEvent.change(pin, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Заблокировать' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный PIN родителя');
    expect(pin).toHaveValue('');

    fireEvent.change(pin, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Разблокировать' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Сервис временно недоступен');
    expect(pin).toHaveValue('654321');
  });

  it('блокирует команды во время запроса и показывает pending', async () => {
    let resolve!: (value: ParentsDashboard['computerAccess']) => void;
    const api = parentsApi();
    vi.mocked(api.changeComputerAccess).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<ParentsScreen childId="c-1" api={api} />);
    fireEvent.change(await screen.findByLabelText(/PIN родителя/u), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Заблокировать' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Изменяю режим доступа…');
    expect(screen.getAllByRole('button')
      .filter((button) => button.closest('.access-mode-control'))
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    resolve({
      ...DASHBOARD.computerAccess,
      override: {
        mode: 'blocked', changedAt: '2099-08-08T12:00:00.000Z', expiresAt: '2099-08-08T21:00:00.000Z',
      },
    });
    expect(await screen.findByText('Режим доступа обновлён.')).toBeInTheDocument();
  });

  it('отключает переключатель, когда PIN на сервере не настроен', async () => {
    render(<ParentsScreen childId="c-1" api={parentsApi({
      ...DASHBOARD,
      computerAccess: { ...DASHBOARD.computerAccess, configured: false },
    })} />);

    const panel = await screen.findByRole('region', { name: 'Компьютер заблокирован' });
    expect(panel).toHaveTextContent('PIN родителя не настроен. Управление доступом отключено.');
    expect(within(panel).queryByLabelText(/PIN родителя/u)).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('button')
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('спокойно показывает пустую историю, темы и наблюдения', async () => {
    render(<ParentsScreen childId="c-1" api={parentsApi({
      ...DASHBOARD,
      gaps: [],
      activity: [],
      flags: { threeFullDaysWithoutRun: false, forecastNotGrowing: [], reduceLoad: [] },
    })} />);

    expect(await screen.findByText('За эту неделю завершённых забегов пока нет.')).toBeInTheDocument();
    expect(screen.getByText('Проблемные темы пока не определились.')).toBeInTheDocument();
    expect(screen.getByText('За неделю нет наблюдений, требующих внимания.')).toBeInTheDocument();
  });

  it('показывает активную проверку и подтверждает вопрос общим PIN родителя', async () => {
    const dashboard: ParentsDashboard = {
      ...DASHBOARD,
      integrityReviews: [{
        runId: 9, kind: 'run', subject: 'math', startedAt: '2026-08-08T11:00:00.000Z',
        status: 'needs_retry', flagged: 1, retryRequired: 1,
      }],
    };
    const detail: ParentsRunDetail = {
      ...RUN_DETAIL,
      runId: 9,
      kind: 'run',
      integrityStatus: 'needs_retry',
      attempts: [{
        ...RUN_DETAIL.attempts[0] as ParentsRunDetail['attempts'][number],
        studentAnswer: 'Ff',
        durationMilliseconds: 1_000,
        current: true,
        integrity: {
          itemId: 17, status: 'retry_required', decision: 'junk', confidence: .97,
          reason: 'Случайные буквы вместо числа.', reviewedBy: 'codex',
        },
      }],
    };
    delete detail.finishedAt;
    const api = parentsApi(dashboard, detail);
    api.approveIntegrity = vi.fn().mockResolvedValue({ status: 'completed', result: {} });
    render(<ParentsScreen childId="c-1" api={api} />);

    const review = await screen.findByRole('region', { name: 'Проверка ответов' });
    fireEvent.change(screen.getByLabelText(/PIN родителя/u), { target: { value: '123456' } });
    fireEvent.click(within(review).getByRole('button', { name: /Обычный забег/u }));
    expect(await screen.findByText('Случайные буквы вместо числа.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ответ осмысленный' }));

    await waitFor(() => expect(api.approveIntegrity).toHaveBeenCalledWith(9, 17, '123456'));
  });

  it('показывает отказ загрузки и использует read-only API', async () => {
    const api = parentsApi();
    vi.mocked(api.read).mockRejectedValue(new Error('Дашборд временно недоступен'));
    render(<ParentsScreen childId="c-1" api={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Дашборд временно недоступен');
    await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('не спрашивает PIN у вошедшего родителя и меняет режим без него', async () => {
    const api = parentsApi({
      ...DASHBOARD,
      computerAccess: { ...DASHBOARD.computerAccess, configured: false },
    });
    render(<ParentsScreen childId="c-1" api={api} pinRequired={false} />);

    const panel = await screen.findByRole('region', { name: 'Компьютер заблокирован' });
    expect(panel).toHaveTextContent('Вы вошли как родитель — PIN не нужен.');
    expect(within(panel).queryByLabelText(/PIN родителя/u)).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Заблокировать' }));
    const confirmation = await screen.findByRole('dialog');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Заблокировать' }));
    await waitFor(() => expect(api.changeComputerAccess).toHaveBeenCalledExactlyOnceWith('blocked'));
  });

  it('переключает ребёнка сводки и гасит прежние цифры до прихода новых', async () => {
    const api = parentsApi();
    const onSelectChild = vi.fn();
    render(
      <ParentsScreen
        childId="c-1"
        api={api}
        siblings={[{ id: 'c-1', name: 'Тимофей' }, { id: 'c-2', name: 'Марта' }]}
        onSelectChild={onSelectChild}
      />,
    );

    const select = await screen.findByLabelText('Ребёнок');
    expect((select as HTMLSelectElement).value).toBe('c-1');
    fireEvent.change(select, { target: { value: 'c-2' } });
    expect(onSelectChild).toHaveBeenCalledWith('c-2');
  });

  it('не показывает переключатель единственному ребёнку', async () => {
    render(<ParentsScreen childId="c-1" api={parentsApi()} siblings={[{ id: 'c-1', name: 'Тимофей' }]} />);

    await screen.findByRole('heading', { name: 'Картина подготовки без приукрашивания' });
    expect(screen.queryByLabelText('Ребёнок')).not.toBeInTheDocument();
  });

  it('перечитывает сводку при смене ребёнка и не показывает чужие цифры', async () => {
    const first = parentsApi();
    const second = parentsApi({ ...DASHBOARD, time: { plannedMinutes: 100, actualMinutes: 7, daily: [] } });
    const { rerender } = render(<ParentsScreen childId="c-1" api={first} />);
    expect(await screen.findByRole('region', { name: 'План и факт' })).toHaveTextContent('Факт35 мин');

    rerender(<ParentsScreen childId="c-2" api={second} />);
    expect(screen.getByRole('status')).toHaveTextContent('Собираю сводку за неделю…');
    expect(await screen.findByRole('region', { name: 'План и факт' })).toHaveTextContent('Факт7 мин');
  });
});
