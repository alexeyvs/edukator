// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminChildScreen, topicNote } from './AdminChildScreen';
import { AdminApp, readAdminPage } from './AdminApp';
import type { AdminApi, AdminChildDetail, AdminTopicCard } from '../admin-api';
import { HttpError } from '../http';
import '../test-setup';

afterEach(cleanup);

function topic(patch: Partial<AdminTopicCard> = {}): AdminTopicCard {
  return {
    topicId: 'math.a',
    title: 'Дроби',
    subject: 'math',
    mastery: 0.42,
    attempts: 12,
    bank: { valid: 3, pending: 1, rejected: 0, used: 8, reserved: 0 },
    ...patch,
  };
}

function detail(patch: Partial<AdminChildDetail> = {}): AdminChildDetail {
  return {
    generatedAt: '2026-08-21T09:00:00.000Z',
    childId: 'ребёнок-1',
    parentId: 'p-1',
    name: 'Старший',
    status: 'ready',
    createdAt: '2026-07-01T09:00:00.000Z',
    lastActivityAt: '2026-08-21T08:00:00.000Z',
    state: 'read',
    schemaVersion: 17,
    topics: [topic()],
    materials: [{
      id: 4,
      topicId: 'math.a',
      subject: 'math',
      status: 'ready',
      createdAt: '2026-08-20T09:00:00.000Z',
      readyAt: '2026-08-20T10:00:00.000Z',
      tasks: 5,
      runs: 1,
    }],
    disputes: [{
      id: 7,
      attemptId: 30,
      topicId: 'math.a',
      status: 'open',
      createdAt: '2026-08-21T07:00:00.000Z',
    }],
    bosses: [{
      id: 2,
      topicId: 'math.b',
      status: 'ready',
      createdAt: '2026-08-19T09:00:00.000Z',
      tasks: 5,
    }],
    gate: {
      day: '2026-08-21',
      required: 3,
      completed: 2,
      remaining: 1,
      learning: { materialId: 4, required: true, passed: false },
      automaticUnlocked: false,
      override: null,
      unlocked: false,
    },
    ...patch,
  } as AdminChildDetail;
}

function adminApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    login: vi.fn().mockResolvedValue({ kind: 'admin', email: 'operator@example.com' }),
    logout: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockRejectedValue(new Error('сводка в этом тесте не спрашивается')),
    logs: vi.fn().mockResolvedValue({ entries: [] }),
    impersonate: vi.fn().mockRejectedValue(new Error('заход в этом тесте не начинается')),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockRejectedValue(new Error('статистика в этом тесте не спрашивается')),
    child: vi.fn().mockResolvedValue(detail()),
    ...overrides,
  };
}

describe('карточка ребёнка в админке', () => {
  it('показывает гейт, банк по темам, разборы, споры и боссов', async () => {
    render(<AdminChildScreen api={adminApi()} childId="ребёнок-1" onSignedOut={vi.fn()} />);

    expect(await screen.findByText('Дневной доступ')).toBeInTheDocument();
    expect(screen.getByText('2 из 3')).toBeInTheDocument();
    expect(screen.getByText('Закрыт')).toBeInTheDocument();
    expect(screen.getByText('Дроби')).toBeInTheDocument();
    expect(screen.getByText(/годных 3/u)).toBeInTheDocument();
    expect(screen.getByText(/Персональные разборы/u)).toBeInTheDocument();
    expect(screen.getByText(/заданий 5 · попыток 1/u)).toBeInTheDocument();
    expect(screen.getByText(/№7/u)).toBeInTheDocument();
    expect(screen.getByText(/№2/u)).toBeInTheDocument();
  });

  it('называет ручную команду родителя отдельно от расчёта', async () => {
    const открыт = detail({
      gate: {
        day: '2026-08-21',
        required: 3,
        completed: 0,
        remaining: 3,
        learning: { materialId: null, required: false, passed: false },
        automaticUnlocked: false,
        override: {
          mode: 'unlocked',
          changedAt: '2026-08-21T08:00:00.000Z',
          expiresAt: '2026-08-21T21:00:00.000Z',
        },
        unlocked: true,
      },
    } as Partial<AdminChildDetail>);
    render(
      <AdminChildScreen
        api={adminApi({ child: vi.fn().mockResolvedValue(открыт) })}
        childId="ребёнок-1"
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Открыт')).toBeInTheDocument();
    expect(screen.getByText(/команда родителя: открыт/u)).toBeInTheDocument();
  });

  it('называет пустым каждый раздел ребёнка, который ещё не занимался', async () => {
    const пустая = detail({
      topics: [],
      materials: [],
      disputes: [],
      bosses: [],
      gate: {
        day: '2026-08-21',
        required: 3,
        completed: 3,
        remaining: 0,
        learning: { materialId: 4, required: true, passed: true },
        automaticUnlocked: true,
        override: null,
        unlocked: true,
      },
    } as Partial<AdminChildDetail>) as AdminChildDetail & { lastActivityAt?: string };
    // Ребёнка завели, а он ни разу не заходил: карточка обязана сказать это
    // словами, иначе пустые разделы читаются как поломка отчёта.
    delete пустая.lastActivityAt;
    render(
      <AdminChildScreen
        api={adminApi({ child: vi.fn().mockResolvedValue(пустая) })}
        childId="ребёнок-1"
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('Ни одной начатой темы')).toBeInTheDocument();
    expect(screen.getByText('Разборов не было')).toBeInTheDocument();
    expect(screen.getByText('Споров не было')).toBeInTheDocument();
    expect(screen.getByText('Боёв не было')).toBeInTheDocument();
    expect(screen.getByText(/ни разу не занимался/u)).toBeInTheDocument();
    expect(screen.getByText(/автоматически открыт/u)).toBeInTheDocument();
    expect(screen.getByText(/зачтён/u)).toBeInTheDocument();
  });

  it('показывает тему без названия, её причину и закрытый спор', async () => {
    const безымянная: AdminTopicCard = {
      topicId: 'math.устаревшая',
      mastery: 0.1,
      attempts: 2,
      bank: { valid: 0, pending: 0, rejected: 1, used: 3, reserved: 0 },
    };
    const карточка = detail({
      topics: [безымянная],
      disputes: [{
        id: 9,
        attemptId: 31,
        topicId: 'math.a',
        status: 'rejected',
        createdAt: '2026-08-20T07:00:00.000Z',
        resolvedAt: '2026-08-20T08:00:00.000Z',
      }],
      gate: {
        day: '2026-08-21',
        required: 3,
        completed: 3,
        remaining: 0,
        learning: { materialId: null, required: false, passed: false },
        automaticUnlocked: true,
        override: {
          mode: 'blocked',
          changedAt: '2026-08-21T08:00:00.000Z',
          expiresAt: '2026-08-21T21:00:00.000Z',
        },
        unlocked: false,
      },
    } as Partial<AdminChildDetail>);
    render(
      <AdminChildScreen
        api={adminApi({ child: vi.fn().mockResolvedValue(карточка) })}
        childId="ребёнок-1"
        onSignedOut={vi.fn()}
      />,
    );

    // Тема из прошлой редакции карты: названия взять негде, и без опознания по
    // идентификатору строка была бы пустой.
    // Название и идентификатор совпадают ровно потому, что названия нет: строка
    // показывает его дважды, а не молчит о теме.
    expect(await screen.findAllByText('math.устаревшая')).toHaveLength(2);
    expect(screen.getByText(/Банк пуст/u)).toBeInTheDocument();
    expect(screen.getByText(/закрыт 20/u)).toBeInTheDocument();
    expect(screen.getByText(/команда родителя: закрыт/u)).toBeInTheDocument();
  });

  it('не выдумывает текста, когда отказ пришёл не ошибкой', async () => {
    const read = vi.fn().mockRejectedValue('строка вместо ошибки');
    render(
      <AdminChildScreen api={adminApi({ child: read })} childId="ребёнок-1" onSignedOut={vi.fn()} />,
    );

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Не получилось загрузить карточку ребёнка');
  });

  it('отличает базу, ждущую первого захода, от пустой', async () => {
    const отставший = detail({ state: 'stale', schemaVersion: 16 } as Partial<AdminChildDetail>);
    render(
      <AdminChildScreen
        api={adminApi({ child: vi.fn().mockResolvedValue(отставший) })}
        childId="ребёнок-1"
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByText('База ждёт первого захода: схема 16.')).toBeInTheDocument();
    expect(screen.queryByText('Дневной доступ')).not.toBeInTheDocument();
  });

  it('называет причину, когда базы нет', async () => {
    const застрявший = detail({
      state: 'failed',
      status: 'provisioning',
      reason: 'Базы ребёнка нет',
    } as Partial<AdminChildDetail>);
    render(
      <AdminChildScreen
        api={adminApi({ child: vi.fn().mockResolvedValue(застрявший) })}
        childId="ребёнок-1"
        onSignedOut={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('База не открылась: Базы ребёнка нет');
    // Всё, что знает управляющая база, остаётся видимым: карточка застрявшего
    // ребёнка и нужна затем, чтобы увидеть его состояние.
    expect(screen.getByText('Старший')).toBeInTheDocument();
  });

  it('повторяет запрос после обрыва', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Не получилось загрузить карточку ребёнка'))
      .mockResolvedValue(detail());
    render(
      <AdminChildScreen api={adminApi({ child: read })} childId="ребёнок-1" onSignedOut={vi.fn()} />,
    );

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Не получилось загрузить карточку ребёнка');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Дневной доступ')).toBeInTheDocument();
  });

  it('кончившуюся сессию оператора отдаёт корню', async () => {
    const signedOut = vi.fn();
    const read = vi.fn().mockRejectedValue(
      new HttpError({ message: 'Нужно войти', status: 401 }),
    );
    render(
      <AdminChildScreen api={adminApi({ child: read })} childId="ребёнок-1" onSignedOut={signedOut} />,
    );

    await waitFor(() => expect(signedOut).toHaveBeenCalledWith('expired'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('почему тема не выдаётся', () => {
  it('различает пустой банк, занятый и закрытую тему', () => {
    expect(topicNote(topic())).toBe('');
    expect(topicNote(topic({ bank: { valid: 0, pending: 0, rejected: 0, used: 4, reserved: 5 } })))
      .toBe('Всё занято боссом или разбором');
    expect(topicNote(topic({ bank: { valid: 0, pending: 2, rejected: 0, used: 4, reserved: 0 } })))
      .toBe('Ждёт проверки');
    expect(topicNote(topic({ bank: { valid: 0, pending: 0, rejected: 3, used: 4, reserved: 0 } })))
      .toBe('Банк пуст');
    // Закрытая тема заданий и не просит: «банк пуст» отправил бы чинить прогрев
    // там, где чинить нечего.
    expect(topicNote(topic({ closedAt: '2026-08-20T09:00:00.000Z' }))).toBe('Тема закрыта');
  });
});

describe('адрес карточки ребёнка', () => {
  it('разбирает `/admin/child/:childId` и отвергает мусор', () => {
    expect(readAdminPage('/admin/child/ребёнок-1')).toEqual({
      kind: 'child',
      childId: 'ребёнок-1',
    });
    expect(readAdminPage('/admin')).toEqual({ kind: 'home' });
    expect(readAdminPage('/admin/child/')).toEqual({ kind: 'home' });
    expect(readAdminPage('/admin/child/a/b')).toEqual({ kind: 'home' });
    // Битая процентная последовательность — не карточка, а главный экран:
    // `decodeURIComponent` бросает на ней, а разбор зовётся из инициализатора
    // состояния, где вылет означает белый экран без единого слова.
    expect(readAdminPage('/admin/child/%')).toEqual({ kind: 'home' });
  });

  it('открывает карточку прямо по адресу страницы', async () => {
    window.history.pushState(null, '', '/admin/child/%D1%80%D0%B5%D0%B1%D1%91%D0%BD%D0%BE%D0%BA-1');
    const read = vi.fn().mockResolvedValue(detail());
    render(<AdminApp api={adminApi({ child: read })} />);

    expect(await screen.findByText('Дневной доступ')).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith('ребёнок-1');
    window.history.pushState(null, '', '/admin');
  });
});
