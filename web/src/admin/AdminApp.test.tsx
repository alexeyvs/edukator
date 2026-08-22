// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import type { AdminApi, AdminChildDetail, AdminOverview, AdminStats } from '../admin-api';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(() => {
  cleanup();
  // Адрес — часть состояния корня: карточка кладётся в историю, и оставленный
  // после сценария путь открывал бы следующему тесту чужой экран.
  window.history.pushState(null, '', '/admin');
});

const HOUR = 60 * 60 * 1000;

function overview(): AdminOverview {
  return {
    generatedAt: '2026-08-21T09:00:00.000Z',
    families: [{
      parentId: 'p-1',
      email: 'первый@example.com',
      createdAt: '2026-08-01T09:00:00.000Z',
      children: [{
        childId: 'ребёнок-1',
        name: 'Старший',
        status: 'ready',
        lastActivityAt: '2026-08-21T08:00:00.000Z',
        createdAt: '2026-08-01T09:00:00.000Z',
      }],
    }],
    parents: { total: 1, last7Days: 0, last30Days: 1, disabled: 0 },
    children: { total: 1, last7Days: 0, last30Days: 1, ready: 1, provisioning: 0, failed: 0, retired: 0 },
    stuck: [],
    quota: { day: '2026-08-21', limit: 60, used: 0, children: [] },
    sessions: { parents: 0, admins: 1 },
    devices: { browser: 1, agent: 0, pendingInvites: 0 },
    lockouts: [],
    storage: {
      controlBytes: 1024,
      childrenBytes: 2048,
      totalBytes: 3072,
      freeBytes: 4096,
      children: [],
    },
  };
}

function stats(): AdminStats {
  return {
    generatedAt: '2026-08-21T09:41:00.000Z',
    day: '2026-08-21',
    engagement: {
      activeToday: 1,
      active7Days: 1,
      active30Days: 1,
      activeMsTotal: HOUR,
      activeMs7Days: HOUR,
      streaks: { withCurrent: 1, longestCurrent: 2, longestEver: 3 },
      churned: 0,
      churnByWeek: [],
    },
    learning: {
      finishedRuns: 3,
      answers: 20,
      correct: 15,
      accuracy: 0.75,
      mastery: [],
      calibrated: [],
      boss: { won: 0, lost: 0, failed: 0, live: 0 },
      integrity: { reviews: 0, needsRetry: 0, retryItems: 0 },
      disputes: { total: 0, upheld: 0, rejected: 0, open: 0 },
    },
    content: {
      codexCalls: 0,
      tasksAdded: 0,
      emptyBanks: [],
      worstTopics: [],
    },
    children: [{
      childId: 'ребёнок-1',
      schemaVersion: 17,
      createdAt: '2026-07-01T09:00:00.000Z',
      lastAttemptAt: '2026-08-21T08:00:00.000Z',
      activeMs: { total: HOUR, last7Days: HOUR, today: HOUR },
      finishedRuns: 3,
      answers: 20,
      correct: 15,
      streak: { current: 2, best: 3 },
      bank: { valid: 5, pending: 0, rejected: 0, used: 20, reserved: 0, addedToday: 0 },
      emptyBankTopics: [],
    }],
    stale: [],
    failed: [],
    skipped: [],
    partial: false,
  };
}

function detail(): AdminChildDetail {
  return {
    generatedAt: '2026-08-21T09:00:00.000Z',
    childId: 'ребёнок-1',
    parentId: 'p-1',
    name: 'Старший',
    status: 'ready',
    createdAt: '2026-07-01T09:00:00.000Z',
    state: 'read',
    schemaVersion: 17,
    topics: [],
    materials: [],
    disputes: [],
    bosses: [],
    gate: {
      day: '2026-08-21',
      required: 3,
      completed: 0,
      remaining: 3,
      learning: { materialId: null, required: false, passed: false },
      automaticUnlocked: false,
      override: null,
      unlocked: false,
    },
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
    impersonate: vi.fn().mockRejectedValue(new Error('заход в этом тесте не начинается')),
    stopImpersonation: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue(stats()),
    child: vi.fn().mockResolvedValue(detail()),
    ...overrides,
  });
}

describe('переходы между экранами админки', () => {
  it('открывает карточку ребёнка со сводки и кладёт её в адрес', async () => {
    render(<AdminApp api={adminApi()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Карточка' }));

    expect(await screen.findByText('Дневной доступ')).toBeInTheDocument();
    // Адрес есть ровно у карточки: её и называют в жалобе, и ссылку на неё
    // хочется уметь отправить себе же.
    expect(window.location.pathname).toBe(`/admin/child/${encodeURIComponent('ребёнок-1')}`);

    fireEvent.click(screen.getByRole('button', { name: 'К сводке' }));

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin');
  });

  it('уводит на статистику, оттуда в карточку и обратно к сводке', async () => {
    render(<AdminApp api={adminApi()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Статистика' }));

    expect(await screen.findByText('Вовлечённость')).toBeInTheDocument();
    // Статистика в истории не остаётся: она открывается от начала работы, а не
    // по ссылке.
    expect(window.location.pathname).toBe('/admin');

    fireEvent.click(screen.getByRole('button', { name: 'Карточка' }));

    expect(await screen.findByText('Дневной доступ')).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/admin/child/${encodeURIComponent('ребёнок-1')}`);

    fireEvent.click(screen.getByRole('button', { name: 'К сводке' }));

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
  });

  it('возвращает «назад» браузера экран вместе с адресом', async () => {
    render(<AdminApp api={adminApi()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Карточка' }));
    await screen.findByText('Дневной доступ');

    // jsdom меняет адрес по `back()`, но `popstate` шлёт сам браузер: сценарий
    // повторяет обе половины руками.
    window.history.back();
    window.history.replaceState(null, '', '/admin');
    fireEvent.popState(window);

    // Без слушателя карточка осталась бы нарисованной поверх `/admin`, а
    // следующее «назад» увело бы с админки, показывая её же.
    expect(await screen.findByText('Семьи')).toBeInTheDocument();
  });

  it('не кладёт в историю повтор `/admin` за каждый экран без адреса', async () => {
    render(<AdminApp api={adminApi()} />);
    const before = window.history.length;

    fireEvent.click(await screen.findByRole('button', { name: 'Статистика' }));
    await screen.findByText('Вовлечённость');
    fireEvent.click(screen.getByRole('button', { name: 'К сводке' }));
    await screen.findByText('Семьи');

    // Иначе «назад» столько же раз не делает ничего видимого, а потом уводит со
    // страницы целиком.
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe('/admin');
  });

  it('возвращает со статистики к сводке своей кнопкой', async () => {
    render(<AdminApp api={adminApi()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Статистика' }));
    await screen.findByText('Вовлечённость');

    fireEvent.click(screen.getByRole('button', { name: 'К сводке' }));

    expect(await screen.findByText('Семьи')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin');
  });
});
