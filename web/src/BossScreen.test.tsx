// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BossScreen } from './BossScreen';
import {
  BossApiError,
  type BossAnswerResponse,
  type BossApi,
  type NextBossTaskResponse,
} from './boss-api';
import './test-setup';

afterEach(cleanup);

function deferred<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function bossTask(position = 1): NextBossTaskResponse {
  return {
    batchId: 3,
    runId: 9,
    position,
    task: {
      id: 100 + position,
      topic_id: 'math.fractions',
      topic_title: 'Обыкновенные дроби',
      subject: 'math',
      question: `Задание номер ${position}`,
      difficulty: 4,
      answer_format: 'number',
    },
  };
}

function bossAnswer(position: number, correct = true): BossAnswerResponse {
  return {
    attemptId: 200 + position,
    correct,
    normalized: correct ? String(position) : 'ошибка',
    answer: String(position),
    explain: 'Разбор не показывается до решения судьбы боя.',
    joke: '',
    xp: correct ? 40 : 0,
    outcome: correct ? (position === 5 ? 'won' : 'active') : 'mistake',
    progress: {
      total: position,
      correct: correct ? position : position - 1,
      target: 5,
      done: correct && position === 5,
    },
  };
}

function apiWith(overrides: Partial<BossApi> = {}): BossApi {
  return {
    state: vi.fn(() => Promise.resolve({
      outcome: 'active' as const,
      progress: { total: 0, correct: 0, target: 5, done: false },
    })),
    next: vi.fn(() => deferred<NextBossTaskResponse>()),
    answer: vi.fn(() => deferred<BossAnswerResponse>()),
    dispute: vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'rejected' as const })),
    concede: vi.fn(() => Promise.resolve({ runId: 9, batchId: 3, replacementBatchId: 4 })),
    ...overrides,
  };
}

async function startFight(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Начать бой' }));
  await screen.findByRole('heading', { name: 'Задание номер 1' });
}

async function submit(value: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Число'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
}

describe('экран босса', () => {
  it('до старта показывает все правила и не загружает задание', () => {
    const api = apiWith();
    render(<BossScreen runId={9} api={api} />);

    expect(screen.getByRole('heading', { name: 'Пять подряд — и тема закрыта' })).toBeInTheDocument();
    expect(screen.getByText('Нужно решить пять заданий подряд.')).toBeInTheDocument();
    expect(screen.getByText('Подсказок не будет.')).toBeInTheDocument();
    expect(screen.getByText('Одна ошибка завершает попытку.')).toBeInTheDocument();
    expect(screen.getByText('Таймера и жизней нет.')).toBeInTheDocument();
    expect(api.next).not.toHaveBeenCalled();
  });

  it('показывает пять делений, только текущую позицию и никогда не рендерит подсказку', async () => {
    const api = apiWith({ next: vi.fn(() => Promise.resolve(bossTask(1))) });
    render(<BossScreen runId={9} api={api} />);
    await startFight();

    expect(screen.getByLabelText('Прогресс босса: 0 из 5').children).toHaveLength(5);
    expect(screen.getByText('задание 1 из 5')).toBeInTheDocument();
    expect(screen.queryByText(/подсказк/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Задание номер 2' })).not.toBeInTheDocument();
  });

  it('побеждает только после пяти верных ответов и сообщает окончательное закрытие темы', async () => {
    const next = vi.fn();
    for (let position = 1; position <= 5; position += 1) {
      next.mockResolvedValueOnce(bossTask(position));
    }
    const answer = vi.fn();
    for (let position = 1; position <= 5; position += 1) {
      answer.mockResolvedValueOnce(bossAnswer(position));
    }
    const api = apiWith({ next, answer });
    render(<BossScreen runId={9} api={api} />);
    await startFight();

    for (let position = 1; position <= 5; position += 1) {
      await submit(String(position));
      if (position < 5) {
        expect(await screen.findByText('Верно')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Дальше' }));
        await screen.findByRole('heading', { name: `Задание номер ${position + 1}` });
      }
    }

    expect(await screen.findByRole('heading', { name: 'Босс побеждён' })).toBeInTheDocument();
    expect(screen.getByText(/Тема закрыта окончательно/u)).toBeInTheDocument();
    expect(next).toHaveBeenCalledTimes(5);
    expect(answer).toHaveBeenCalledTimes(5);
  });

  it('после ошибки предлагает спор или признание поражения', async () => {
    const api = apiWith({
      next: vi.fn(() => Promise.resolve(bossTask(1))),
      answer: vi.fn(() => Promise.resolve(bossAnswer(1, false))),
    });
    render(<BossScreen runId={9} api={api} />);
    await startFight();
    await submit('не знаю');

    expect(await screen.findByText('Ошибка')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Я всё-таки прав' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Признать поражение' })).toBeInTheDocument();
    expect(screen.getByLabelText('Число')).toHaveAttribute('readonly');
  });

  it('опрашивает открытый спор с backoff, блокирует действия и после upheld продолжает с очередной позиции', async () => {
    let releaseWait!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseWait = resolve; });
    const delays: number[] = [];
    const dispute = vi.fn()
      .mockResolvedValueOnce({ dispute_id: 7, status: 'open' as const })
      .mockResolvedValueOnce({ dispute_id: 7, status: 'upheld' as const });
    const api = apiWith({
      next: vi.fn()
        .mockResolvedValueOnce(bossTask(1))
        .mockResolvedValueOnce(bossTask(2)),
      answer: vi.fn(() => Promise.resolve(bossAnswer(1, false))),
      dispute,
    });
    render(<BossScreen runId={9} api={api} wait={(delay) => {
      delays.push(delay);
      return firstWait;
    }} />);
    await startFight();
    await submit('нет');
    fireEvent.click(await screen.findByRole('button', { name: 'Я всё-таки прав' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Ответить снова пока нельзя');
    expect(screen.getByRole('button', { name: 'Я всё-таки прав' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Признать поражение' })).toBeDisabled();
    releaseWait();

    expect(await screen.findByRole('heading', { name: 'Задание номер 2' })).toBeInTheDocument();
    expect(dispute).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000]);
  });

  it('после rejected показывает поражение и подготовку свежего набора', async () => {
    const api = apiWith({
      next: vi.fn(() => Promise.resolve(bossTask(1))),
      answer: vi.fn(() => Promise.resolve(bossAnswer(1, false))),
      dispute: vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'rejected' as const })),
    });
    render(<BossScreen runId={9} api={api} />);
    await startFight();
    await submit('нет');
    fireEvent.click(await screen.findByRole('button', { name: 'Я всё-таки прав' }));

    expect(await screen.findByRole('heading', { name: 'Попытка завершена' })).toBeInTheDocument();
    expect(screen.getByText(/Никакого календарного наказания/u)).toBeInTheDocument();
    expect(screen.getByText(/Новый набор уже готовится/u)).toBeInTheDocument();
  });

  it('признание поражения вызывает concede и показывает спокойный исход', async () => {
    const concede = vi.fn(() => Promise.resolve({ runId: 9, batchId: 3, replacementBatchId: 4 }));
    const api = apiWith({
      next: vi.fn(() => Promise.resolve(bossTask(1))),
      answer: vi.fn(() => Promise.resolve(bossAnswer(1, false))),
      concede,
    });
    render(<BossScreen runId={9} api={api} />);
    await startFight();
    await submit('нет');
    fireEvent.click(await screen.findByRole('button', { name: 'Признать поражение' }));

    expect(await screen.findByRole('heading', { name: 'Попытка завершена' })).toBeInTheDocument();
    expect(concede).toHaveBeenCalledWith(9);
  });

  it('после refresh снова показывает правила и восстанавливает ту же очередную позицию', async () => {
    const next = vi.fn(() => Promise.resolve(bossTask(3)));
    const api = apiWith({ next });
    const view = render(<BossScreen runId={9} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Начать бой' }));
    await screen.findByRole('heading', { name: 'Задание номер 3' });

    view.unmount();
    render(<BossScreen runId={9} api={api} />);
    expect(screen.getByRole('heading', { name: 'Пять подряд — и тема закрыта' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Начать бой' }));

    expect(await screen.findByRole('heading', { name: 'Задание номер 3' })).toBeInTheDocument();
    expect(screen.getByLabelText('Прогресс босса: 2 из 5')).toBeInTheDocument();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('после refresh восстанавливает неверный ответ и оставляет спор и concede доступными', async () => {
    const api = apiWith({
      state: vi.fn(() => Promise.resolve({
        outcome: 'mistake' as const, attemptId: 205,
        progress: { total: 3, correct: 2, target: 5, done: false },
      })),
    });
    render(<BossScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Ответ не засчитан' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Я всё-таки прав' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Признать поражение' })).toBeEnabled();
  });

  it('блокирует оба исхода восстановленной ошибки, пока concede не завершился', async () => {
    const concede = vi.fn(() => deferred<{ runId: number; batchId: number; replacementBatchId: number }>());
    const dispute = vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'rejected' as const }));
    const api = apiWith({
      state: vi.fn(() => Promise.resolve({
        outcome: 'mistake' as const, attemptId: 205,
        progress: { total: 3, correct: 2, target: 5, done: false },
      })),
      concede,
      dispute,
    });
    render(<BossScreen runId={9} api={api} />);

    const concedeButton = await screen.findByRole('button', { name: 'Признать поражение' });
    fireEvent.click(concedeButton);

    expect(concedeButton).toBeDisabled();
    const disputeButton = screen.getByRole('button', { name: 'Я всё-таки прав' });
    expect(disputeButton).toBeDisabled();
    fireEvent.click(disputeButton);
    expect(concede).toHaveBeenCalledTimes(1);
    expect(dispute).not.toHaveBeenCalled();
  });

  it('после refresh продолжает открытый спор и показывает победу после upheld на пятой позиции', async () => {
    const api = apiWith({
      state: vi.fn()
        .mockResolvedValueOnce({
          outcome: 'dispute' as const, attemptId: 205,
          progress: { total: 5, correct: 4, target: 5, done: false },
        })
        .mockResolvedValueOnce({
          outcome: 'won' as const,
          progress: { total: 5, correct: 5, target: 5, done: true },
        }),
      dispute: vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'upheld' as const })),
    });
    render(<BossScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Босс побеждён' })).toBeInTheDocument();
    expect(api.dispute).toHaveBeenCalledWith(205);
  });

  it('после refresh показывает сохранённую победу вместо подготовки нового батча', async () => {
    const api = apiWith({
      state: vi.fn(() => Promise.resolve({
        outcome: 'won' as const,
        progress: { total: 5, correct: 5, target: 5, done: true },
      })),
    });
    render(<BossScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Босс побеждён' })).toBeInTheDocument();
    expect(api.next).not.toHaveBeenCalled();
  });

  it('объясняет недоступность нового батча без ложного наказания', async () => {
    const api = apiWith({
      next: vi.fn(() => Promise.reject(
        new BossApiError('готового полного батча нет', 409, 'boss-not-ready'),
      )),
    });
    render(<BossScreen runId={9} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Начать бой' }));

    expect(await screen.findByRole('heading', { name: 'Бой приостановлен' })).toBeInTheDocument();
    expect(screen.getByText('Этот бой сейчас недоступен. Новый набор заданий ещё готовится.'))
      .toBeInTheDocument();
  });

  it('показывает ошибку API и не оставляет активный ввод', async () => {
    const api = apiWith({ next: vi.fn(() => Promise.reject(new Error('Сеть пропала'))) });
    render(<BossScreen runId={9} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Начать бой' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Сеть пропала');
    expect(screen.queryByLabelText('Число')).not.toBeInTheDocument();
  });
});
