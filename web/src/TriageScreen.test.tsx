// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriageScreen } from './TriageScreen';
import type {
  DisputeResponse,
  FinishRunResponse,
  NextTaskResponse,
  RunApi,
} from './run-api';
import './test-setup';

afterEach(cleanup);

function deferred<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function finish(): FinishRunResponse {
  return {
    runId: 12,
    total: 1,
    correct: 1,
    xp: 25,
    touchedTopics: [
      { topicId: 'math.a', title: 'Дроби', before: 0, after: 0.4 },
    ],
    closedTopics: [],
    declinedTopics: [],
    forecast: {
      id: 1,
      subject: 'math',
      score: 2,
      band: 1,
      createdAt: '2026-08-08T12:00:00.000Z',
    },
  };
}

function apiWith(overrides: Partial<RunApi> = {}): RunApi {
  return {
    next: vi.fn(() => deferred<NextTaskResponse>()),
    dispute: vi.fn(() => deferred<DisputeResponse>()),
    finish: vi.fn(() => Promise.resolve(finish())),
    triageNext: vi.fn(() => Promise.resolve({
      status: 'ok' as const,
      progress: { total: 0, correct: 0, target: 12, done: false },
      task: {
        id: 4,
        topic_id: 'math.a',
        topic_title: 'Дроби',
        subject: 'math' as const,
        question: 'Чему равна половина от восьми?',
        difficulty: 2,
        answer_format: 'number' as const,
      },
    })),
    answer: vi.fn(() => Promise.resolve({
      attempt_id: 8,
      correct: true,
      normalized: '4',
      answer: '4',
      explain: 'Половина восьми — четыре.',
      joke: 'Точно пополам.',
      xp: 25,
      progress: { total: 1, correct: 1, target: 12, done: false },
    })),
    ...overrides,
  };
}

describe('экран триажа', () => {
  it('проводит вопрос без подсказки и передаёт ответ без её использования', async () => {
    const api = apiWith();
    render(<TriageScreen runId={12} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Чему равна половина от восьми?' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /подсказ/ui })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({
      runId: 12,
      taskId: 4,
      hintUsed: false,
    }));
  });

  it('показывает ранжирование, когда темы закончились досрочно', async () => {
    const api = apiWith({
      triageNext: vi.fn(() => Promise.resolve({
        status: 'done' as const,
        total: 1,
        target: 12,
      })),
    });
    render(<TriageScreen runId={12} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Карта тем на старте' })).toBeInTheDocument();
    expect(screen.getByText('Дроби')).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(12);
  });
});
