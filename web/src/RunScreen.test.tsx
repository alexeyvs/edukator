// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunScreen } from './RunScreen';
import {
  RunApiError,
  type AnswerResponse,
  type FinishRunResponse,
  type NextTaskResponse,
  type NextTriageResponse,
  type RunApi,
} from './run-api';
import './test-setup';

afterEach(cleanup);

function task(id: number, question = `Сколько будет ${id} + ${id}?`): NextTaskResponse {
  return {
    task: {
      id,
      topic_id: 'math.numbers',
      topic_title: 'Натуральные числа',
      subject: 'math',
      question,
      hint: 'Сложи одинаковые числа.',
      difficulty: 2,
      answer_format: 'number',
    },
    progress: { total: id - 1, correct: id - 1, target: 12, done: false },
  };
}

function answer(correct = true): AnswerResponse {
  return {
    attempt_id: 41,
    correct,
    normalized: correct ? '2' : '3',
    answer: '2',
    explain: 'Один плюс один равен двум.',
    joke: 'Даже калькулятор одобрительно кивнул.',
    xp: correct ? 25 : 0,
    progress: { total: 1, correct: correct ? 1 : 0, target: 12, done: false },
  };
}

function finishSummary(): FinishRunResponse {
  return {
    runId: 9,
    total: 12,
    correct: 10,
    xp: 245,
    touchedTopics: [],
    closedTopics: [],
    declinedTopics: [],
    forecast: {
      id: 2,
      subject: 'math',
      score: 3.5,
      band: 0.4,
      createdAt: '2026-08-08T12:00:00.000Z',
    },
  };
}

function deferred<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function apiWith(overrides: Partial<RunApi> = {}): RunApi {
  return {
    next: vi.fn(() => deferred<NextTaskResponse>()),
    answer: vi.fn(() => Promise.resolve(answer())),
    dispute: vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'rejected' as const })),
    finish: vi.fn(() => deferred<FinishRunResponse>()),
    triageNext: vi.fn(() => deferred<NextTriageResponse>()),
    ...overrides,
  };
}

describe('экран забега', () => {
  it('держит прогресс на виду, показывает подсказку и полный результат ответа', async () => {
    const api = apiWith({
      next: vi.fn()
        .mockResolvedValueOnce(task(1, 'Сколько будет 1 + 1?'))
        .mockReturnValue(deferred<NextTaskResponse>()),
    });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Прогресс: 0 из 12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Нужна подсказка' }));
    expect(screen.getByText('Сложи одинаковые числа.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(screen.getByText('+25 XP')).toBeInTheDocument();
    expect(screen.getByText('Один плюс один равен двум.')).toBeInTheDocument();
    expect(screen.getByText('Даже калькулятор одобрительно кивнул.')).toBeInTheDocument();
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({
      runId: 9,
      taskId: 1,
      answer: '2',
      hintUsed: true,
    }));
  });

  it('предзагружает следующее задание сразу после показа текущего', async () => {
    const next = vi.fn()
      .mockResolvedValueOnce(task(1, 'Первое задание'))
      .mockResolvedValueOnce(task(2, 'Следующее задание'))
      .mockReturnValue(deferred<NextTaskResponse>());
    const api = apiWith({ next });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Первое задание' })).toBeInTheDocument();
    await waitFor(() => expect(next).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '2' } });
    fireEvent.submit(screen.getByLabelText('Число').closest('form') as HTMLFormElement);
    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(next).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Следующее задание' }));
    expect(await screen.findByRole('heading', { name: 'Следующее задание' })).toBeInTheDocument();
  });

  it('после целевого ответа закрывает забег и показывает финал', async () => {
    const last = task(12, 'Последнее задание');
    last.progress = { total: 11, correct: 9, target: 12, done: false };
    const finalAnswer = answer(true);
    finalAnswer.progress = { total: 12, correct: 10, target: 12, done: true };
    const api = apiWith({
      next: vi.fn(() => Promise.resolve(last)),
      answer: vi.fn(() => Promise.resolve(finalAnswer)),
      finish: vi.fn(() => Promise.resolve(finishSummary())),
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Последнее задание' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Завершить забег' }));

    expect(await screen.findByRole('heading', { name: 'Вот что получилось' })).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(9);
    expect(api.next).toHaveBeenCalledTimes(1);
  });

  it('опрашивает спор до первого закрытого статуса с нарастающей паузой', async () => {
    const delays: number[] = [];
    const dispute = vi.fn()
      .mockResolvedValueOnce({ dispute_id: 7, status: 'open' })
      .mockResolvedValueOnce({ dispute_id: 7, status: 'open' })
      .mockResolvedValueOnce({ dispute_id: 7, status: 'rejected' });
    const api = apiWith({
      next: vi.fn()
        .mockResolvedValueOnce(task(1))
        .mockReturnValue(deferred<NextTaskResponse>()),
      answer: vi.fn(() => Promise.resolve(answer(false))),
      dispute,
    });
    render(
      <RunScreen
        runId={9}
        api={api}
        wait={(delay) => {
          delays.push(delay);
          return Promise.resolve();
        }}
      />,
    );

    await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Я всё-таки прав' }));

    expect(await screen.findByText('Проверил ещё раз: эталон остаётся в силе.')).toBeInTheDocument();
    expect(delays).toEqual([1_000, 2_000]);
    expect(dispute).toHaveBeenCalledTimes(3);
  });

  it('показывает пустую очередь и автоматически повторяет запрос', async () => {
    const delays: number[] = [];
    const api = apiWith({
      next: vi.fn()
        .mockRejectedValueOnce(new RunApiError('нет готовых заданий', 503, 'no-task'))
        .mockResolvedValueOnce(task(1))
        .mockReturnValue(deferred<NextTaskResponse>()),
    });
    render(
      <RunScreen
        runId={9}
        api={api}
        wait={(delay) => {
          delays.push(delay);
          return Promise.resolve();
        }}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' })).toBeInTheDocument();
    expect(delays).toEqual([2_000]);
  });

  it.each([
    ['no-topic', 'На сегодня всё закрыто'],
    ['restart-required', 'Нужен перезапуск'],
  ])('переводит отказ %s в отдельный экран', async (code, heading) => {
    const api = apiWith({
      next: vi.fn(() => Promise.reject(new RunApiError('отказ', 503, code))),
    });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });
});
