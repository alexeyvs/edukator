// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriageScreen } from './TriageScreen';
import type {
  DisputeResponse,
  FinishRunResponse,
  NextTaskResponse,
  RunApi,
  NextTriageResponse,
} from './run-api';
import './test-setup';

afterEach(cleanup);

function deferred<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function controlled<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  it('использует общий структурированный prompt и radio-карточки', async () => {
    const api = apiWith({
      triageNext: vi.fn(() => Promise.resolve({
        status: 'ok' as const,
        progress: { total: 0, correct: 0, target: 12, done: false },
        task: {
          id: 4, topic_id: 'math.a', topic_title: 'Дроби', subject: 'math' as const,
          question: 'fallback', instruction: 'Выбери дробь', material: String.raw`\frac12`,
          material_format: 'math' as const, choices: ['1/2', '2/1'], difficulty: 2,
          answer_format: 'choice' as const,
        },
      })),
    });
    render(<TriageScreen runId={12} api={api} />);

    await screen.findByRole('heading', { name: 'Выбери дробь' });
    expect(screen.getByRole('region', { name: 'Материал задания' }).querySelector('.katex')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /1\/2/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Верно');
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({ answer: '1/2', hintUsed: false }));
  });

  it('проводит вопрос без подсказки и передаёт ответ без её использования', async () => {
    const api = apiWith();
    render(<TriageScreen runId={12} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Чему равна половина от восьми?' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /подсказ/ui })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(screen.getByText('+25 XP')).toBeInTheDocument();
    expect(screen.getByText('Точно пополам.')).toBeInTheDocument();
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({
      runId: 12,
      taskId: 4,
      hintUsed: false,
    }));
  });

  it('разбирает спор до подтверждения и возвращает баллы', async () => {
    const dispute = vi.fn()
      .mockResolvedValueOnce({ dispute_id: 9, status: 'open' as const })
      .mockResolvedValueOnce({ dispute_id: 9, status: 'upheld' as const });
    const wrong = apiWith({
      answer: vi.fn(() => Promise.resolve({
        attempt_id: 9,
        correct: false,
        normalized: 'пять',
        answer: '4',
        explain: 'Половина восьми — четыре.',
        joke: 'Давай перепроверим.',
        xp: 0,
        progress: { total: 1, correct: 0, target: 12, done: false },
      })),
      dispute,
    });
    render(<TriageScreen runId={12} api={wrong} wait={() => Promise.resolve()} />);

    await screen.findByRole('heading', { name: 'Чему равна половина от восьми?' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: 'пять' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Я всё-таки прав' }));

    expect(await screen.findByText('Ты был прав — баллы вернулись.')).toBeInTheDocument();
    expect(dispute).toHaveBeenCalledTimes(2);
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

  it('не показывает вопрос старого триажа после смены runId', async () => {
    const old = controlled<NextTriageResponse>();
    const firstApi = apiWith({ triageNext: vi.fn(() => old.promise) });
    const secondApi = apiWith({ triageNext: vi.fn(() => Promise.resolve({
      status: 'ok' as const,
      progress: { total: 0, correct: 0, target: 12, done: false },
      task: {
        id: 5,
        topic_id: 'math.b',
        topic_title: 'Проценты',
        subject: 'math' as const,
        question: 'Новый вопрос',
        difficulty: 2,
        answer_format: 'number' as const,
      },
    })) });
    const view = render(<TriageScreen runId={1} api={firstApi} />);

    view.rerender(<TriageScreen runId={2} api={secondApi} />);
    expect(await screen.findByRole('heading', { name: 'Новый вопрос' })).toBeInTheDocument();
    old.resolve({
      status: 'ok',
      progress: { total: 0, correct: 0, target: 12, done: false },
      task: {
        id: 4,
        topic_id: 'math.a',
        topic_title: 'Дроби',
        subject: 'math',
        question: 'Старый вопрос',
        difficulty: 2,
        answer_format: 'number',
      },
    });

    await screen.findByRole('heading', { name: 'Новый вопрос' });
    expect(screen.queryByRole('heading', { name: 'Старый вопрос' })).not.toBeInTheDocument();
  });

  it('показывает ошибки загрузки, ответа и завершения', async () => {
    const loadApi = apiWith({ triageNext: vi.fn(() => Promise.reject(new Error('load'))) });
    const loadView = render(<TriageScreen runId={12} api={loadApi} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось загрузить вопрос');
    loadView.unmount();

    const answerApi = apiWith({ answer: vi.fn(() => Promise.reject(new Error('answer'))) });
    const answerView = render(<TriageScreen runId={12} api={answerApi} />);
    await screen.findByRole('heading', { name: 'Чему равна половина от восьми?' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось проверить ответ');
    answerView.unmount();

    const finishApi = apiWith({
      triageNext: vi.fn(() => Promise.resolve({ status: 'done' as const, total: 1, target: 12 })),
      finish: vi.fn(() => Promise.reject(new Error('finish'))),
    });
    render(<TriageScreen runId={12} api={finishApi} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не получилось собрать итог');
  });
});
