// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminStatsScreen, hours, share, statsTime } from './AdminStatsScreen';
import type { AdminApi, AdminStats } from '../admin-api';
import { HttpError } from '../http';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

function stats(patch: Partial<AdminStats> = {}): AdminStats {
  return {
    generatedAt: '2026-08-21T09:41:00.000Z',
    day: '2026-08-21',
    engagement: {
      activeToday: 2,
      active7Days: 5,
      active30Days: 9,
      activeMsTotal: 12 * HOUR,
      activeMs7Days: 3 * HOUR,
      streaks: { withCurrent: 2, longestCurrent: 4, longestEver: 11 },
      churned: 1,
      churnByWeek: [{ week: 2, children: 1 }],
    },
    learning: {
      finishedRuns: 30,
      answers: 200,
      correct: 150,
      accuracy: 0.75,
      mastery: [{ subject: 'math', average: 0.42, topics: 8, children: 3 }],
      calibrated: [{ subject: 'math', children: 2 }],
      boss: { won: 3, lost: 1, failed: 0, live: 1 },
      integrity: { reviews: 4, needsRetry: 1, retryItems: 2 },
      disputes: { total: 4, upheld: 1, rejected: 3, open: 0, upheldShare: 0.25 },
    },
    content: {
      codexCalls: 24,
      tasksAdded: 12,
      callsPerTask: 2,
      emptyBanks: [{ topicId: 'math.a', children: 2 }],
      worstTopics: [{ topicId: 'math.b', answers: 12, correct: 3, accuracy: 0.25 }],
    },
    children: [
      {
        childId: 'ребёнок-1',
        schemaVersion: 17,
        createdAt: '2026-07-01T09:00:00.000Z',
        lastAttemptAt: '2026-08-21T08:00:00.000Z',
        activeMs: { total: 12 * HOUR, last7Days: 3 * HOUR, today: HOUR },
        finishedRuns: 30,
        answers: 200,
        correct: 150,
        streak: { current: 4, best: 11 },
        bank: { valid: 20, pending: 2, rejected: 1, used: 40, reserved: 5, addedToday: 12 },
        emptyBankTopics: ['math.a'],
      },
    ],
    stale: [],
    failed: [],
    skipped: [],
    partial: false,
    ...patch,
  };
}

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  // Состав методов держит общий помощник: всё, что этому файлу нужно,
  // названо здесь, остальное отказывает.
  return testAdminApi({
    login: vi.fn().mockResolvedValue({ kind: 'admin', email: 'operator@example.com' }),
    logout: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockRejectedValue(new Error('сводка в этом тесте не спрашивается')),
    logs: vi.fn().mockResolvedValue({ entries: [] }),
    impersonate: vi.fn().mockRejectedValue(new Error('заход в этом тесте не начинается')),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue(stats()),
    child: vi.fn().mockRejectedValue(new Error('карточка в этом тесте не спрашивается')),
    ...overrides,
  });
}

describe('экран статистики оператора', () => {
  it('показывает три слоя чисел и отметку времени', async () => {
    render(<AdminStatsScreen api={adminApi()} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Вовлечённость')).toBeInTheDocument();
    expect(screen.getByText(`Данные на ${statsTime('2026-08-21T09:41:00.000Z')}`))
      .toBeInTheDocument();
    expect(screen.getByText('Учебная картина')).toBeInTheDocument();
    expect(screen.getByText('Качество контента')).toBeInTheDocument();
    expect(screen.getByText('12.0 ч')).toBeInTheDocument();
    expect(screen.getByText(/точность 75%/u)).toBeInTheDocument();
    expect(screen.getByText(/math\.b/u)).toBeInTheDocument();
  });

  it('первый заход не заказывает пересчёта, а кнопка — заказывает', async () => {
    const read = vi.fn().mockResolvedValue(stats());
    render(<AdminStatsScreen api={adminApi({ stats: read })} onSignedOut={vi.fn()} />);

    await screen.findByText('Вовлечённость');
    // Пересчёт открывает все детские базы по одной: заход на экран его не
    // заказывает, иначе перезагрузка страницы платила бы обходом.
    expect(read).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Пересчитать' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith(true);
  });

  it('называет неполный отчёт и перечисляет непрочитанные базы', async () => {
    const неполный = stats({
      partial: true,
      failed: [{ childId: 'ребёнок-2', reason: 'файл не открылся' }],
      stale: [{ childId: 'ребёнок-3', schemaVersion: 16 }],
    });
    render(
      <AdminStatsScreen
        api={adminApi({ stats: vi.fn().mockResolvedValue(неполный) })}
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Отчёт неполный: прочитаны не все базы.');
    expect(screen.getByText(/файл не открылся/u)).toBeInTheDocument();
    expect(screen.getByText(/схема 16/u)).toBeInTheDocument();
    // Числа по прочитанным детям остаются на экране: отказ одной базы не
    // отменяет отчёта, и пустой экран вместо него был бы хуже неполного.
    expect(screen.getByText('Вовлечённость')).toBeInTheDocument();
  });

  it('уводит к карточке ребёнка', async () => {
    const open = vi.fn();
    render(<AdminStatsScreen api={adminApi()} onChild={open} onSignedOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Карточка' }));
    expect(open).toHaveBeenCalledWith('ребёнок-1');
  });

  it('повторяет запрос после обрыва, не заказывая пересчёта', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось загрузить статистику'))
      .mockResolvedValue(stats());
    render(<AdminStatsScreen api={adminApi({ stats: read })} onSignedOut={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось загрузить статистику');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Вовлечённость')).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith(false);
  });

  it('кончившуюся сессию оператора отдаёт корню, а не показывает поломкой', async () => {
    const signedOut = vi.fn();
    const read = vi.fn().mockRejectedValue(
      new HttpError({ message: 'Не получилось загрузить статистику', status: 401 }),
    );
    render(<AdminStatsScreen api={adminApi({ stats: read })} onSignedOut={signedOut} />);

    await waitFor(() => expect(signedOut).toHaveBeenCalledWith('expired'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('форматы экрана статистики', () => {
  it('показывает часы, а не миллисекунды', () => {
    expect(hours(90 * 60 * 1000)).toBe('1.5 ч');
  });

  it('различает отсутствующую долю и нулевую', () => {
    // «Ни одного ответа ещё не было» и «все ответы мимо» — разные состояния.
    expect(share(undefined)).toBe('—');
    expect(share(0)).toBe('0%');
  });
});
