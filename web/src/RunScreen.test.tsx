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
import type { FinishLearningResponse } from './learning-api';

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

function lives(remaining: number, retryAvailable: boolean): NonNullable<NextTaskResponse['progress']['lives']> {
  return { total: 3, remaining, retryAvailable };
}

function retryableWrong(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    ...answer(false),
    progress: {
      total: 1,
      correct: 0,
      target: 12,
      done: false,
      lives: lives(3, true),
    },
    ...overrides,
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

function controlled<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function apiWith(overrides: Partial<RunApi> = {}): RunApi {
  return {
    next: vi.fn(() => deferred<NextTaskResponse>()),
    answer: vi.fn(() => Promise.resolve(answer())),
    skipRetry: vi.fn(() => deferred<{ progress: NextTaskResponse['progress'] }>()),
    dispute: vi.fn(() => Promise.resolve({ dispute_id: 7, status: 'rejected' as const })),
    finish: vi.fn(() => deferred<FinishRunResponse>()),
    triageNext: vi.fn(() => deferred<NextTriageResponse>()),
    ...overrides,
  };
}

describe('экран забега', () => {
  it('переиспользует механику для теста по разбору без подсказок и после ответа оставляет ссылку в тесте', async () => {
    const lessonTask = task(1, 'Сколько будет одна вторая плюс одна вторая?');
    lessonTask.progress = { total: 0, correct: 0, target: 5, done: false };
    delete lessonTask.task.hint;
    const lessonAnswer = answer(true);
    lessonAnswer.progress = { total: 1, correct: 1, target: 5, done: false };
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(lessonTask).mockReturnValue(deferred<NextTaskResponse>()),
      answer: vi.fn().mockResolvedValue(lessonAnswer),
    });
    render(<RunScreen runId={31} kind="lesson" api={api} />);

    expect(await screen.findByText('Проверка темы')).toBeInTheDocument();
    expect(screen.getByLabelText('Прогресс: 0 из 5')).toBeInTheDocument();
    expect(screen.queryByText(/Жизни:/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Нужна подсказка' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({ hintUsed: false }));
    expect(screen.getByRole('link', { name: 'Вернуться к тесту' }))
      .toHaveAttribute('href', '/?runId=31&kind=lesson');
  });

  it('завершает пятый ответ только через learning API и показывает зачёт', async () => {
    const last = task(5, 'Последний вопрос разбора');
    last.progress = { total: 4, correct: 3, target: 5, done: false };
    delete last.task.hint;
    const finalAnswer = answer(true);
    finalAnswer.progress = { total: 5, correct: 4, target: 5, done: true };
    const api = apiWith({
      next: vi.fn().mockResolvedValue(last),
      answer: vi.fn().mockResolvedValue(finalAnswer),
      finish: vi.fn(),
    });
    const finish: FinishLearningResponse = {
      ...finishSummary(), runId: 31, materialId: 21, total: 5, correct: 4, xp: 100,
      outcome: 'passed', required: true, masteryBefore: .3, masteryAfter: .6, passScore: 4,
    };
    const learningApi = { finish: vi.fn().mockResolvedValue(finish) };
    render(<RunScreen runId={31} kind="lesson" api={api} learningApi={learningApi} />);

    await screen.findByRole('heading', { name: 'Последний вопрос разбора' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Завершить тест' }));

    expect(await screen.findByRole('heading', { name: 'Зачёт' })).toBeInTheDocument();
    expect(learningApi.finish).toHaveBeenCalledWith(31);
    expect(api.finish).not.toHaveBeenCalled();
  });

  it('для choice блокирует пустую отправку и отправляет текст radio-варианта', async () => {
    const choice = task(1);
    Object.assign(choice.task, {
      instruction: 'Выбери результат',
      material: '2 + 2',
      material_format: 'math',
      choices: ['3', '4', '5'],
      answer_format: 'choice',
    });
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(choice).mockReturnValue(deferred<NextTaskResponse>()),
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Выбери результат' });
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /4/u }));
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    await screen.findByText('Верно');
    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({ answer: '4' }));
  });

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

  it('не списывает сердце за ошибку до отправки ретрая', async () => {
    const first = task(1);
    first.progress.lives = lives(3, false);
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(first).mockReturnValue(deferred<NextTaskResponse>()),
      answer: vi.fn().mockResolvedValue(retryableWrong()),
    });
    const view = render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' });
    expect(screen.getByText('Жизни: 3 из 3')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.lives-hearts > span')).toHaveLength(3);
    expect(view.container.querySelectorAll('.life-full')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Жизни: 3 из 3')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.life-full')).toHaveLength(3);
    expect(view.container.querySelectorAll('.life-empty')).toHaveLength(0);
  });

  it('исправляет ответ с очищенным вводом, сохранённой подсказкой и ссылкой на попытку', async () => {
    const first = task(1);
    first.progress.lives = lives(3, false);
    const corrected = answer(true);
    corrected.progress = {
      total: 1, correct: 1, target: 12, done: false, lives: lives(2, false),
    };
    const submitAnswer = vi.fn()
      .mockResolvedValueOnce(retryableWrong())
      .mockResolvedValueOnce(corrected);
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(first).mockReturnValue(deferred<NextTaskResponse>()),
      answer: submitAnswer,
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' });
    fireEvent.click(screen.getByRole('button', { name: 'Нужна подсказка' }));
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByRole('button', { name: 'Я всё-таки прав' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Исправить ответ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Следующее задание' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Исправить ответ' }));

    const input = screen.getByLabelText('Число');
    expect(input).toHaveValue('');
    expect(screen.getByText('Сложи одинаковые числа.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Верно')).toBeInTheDocument();
    expect(submitAnswer).toHaveBeenNthCalledWith(2, expect.objectContaining({
      taskId: 1,
      answer: '2',
      hintUsed: true,
      retryAttemptId: 41,
    }));
    expect(screen.getByLabelText('Прогресс: 1 из 12')).toBeInTheDocument();
  });

  it('пропускает исправление и показывает предзагруженное следующее задание', async () => {
    const first = task(1, 'Первый вопрос');
    first.progress.lives = lives(3, false);
    const second = task(2, 'Второй вопрос');
    second.progress.lives = lives(3, false);
    const next = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockReturnValue(deferred<NextTaskResponse>());
    const skipRetry = vi.fn().mockResolvedValue({
      progress: { total: 1, correct: 0, target: 12, done: false, lives: lives(3, false) },
    });
    const api = apiWith({ next, answer: vi.fn().mockResolvedValue(retryableWrong()), skipRetry });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Первый вопрос' });
    await waitFor(() => expect(next).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Следующее задание' }));

    expect(await screen.findByRole('heading', { name: 'Второй вопрос' })).toBeInTheDocument();
    expect(skipRetry).toHaveBeenCalledWith(9, 1);
    expect(screen.getByLabelText('Прогресс: 1 из 12')).toBeInTheDocument();
    expect(screen.getByText('Жизни: 3 из 3')).toBeInTheDocument();
  });

  it('после пропуска исправления двенадцатого ответа сразу завершает забег', async () => {
    const last = task(12, 'Последняя ошибка');
    last.progress = {
      total: 11, correct: 10, target: 12, done: false, lives: lives(3, false),
    };
    const wrong = retryableWrong({
      progress: { total: 12, correct: 10, target: 12, done: false, lives: lives(3, true) },
    });
    const api = apiWith({
      next: vi.fn().mockResolvedValue(last),
      answer: vi.fn().mockResolvedValue(wrong),
      skipRetry: vi.fn().mockResolvedValue({
        progress: { total: 12, correct: 10, target: 12, done: true, lives: lives(3, false) },
      }),
      finish: vi.fn().mockResolvedValue(finishSummary()),
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Последняя ошибка' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Следующее задание' }));

    expect(await screen.findByRole('heading', { name: 'Вот что получилось' })).toBeInTheDocument();
    expect(api.skipRetry).toHaveBeenCalledWith(9, 12);
    expect(api.finish).toHaveBeenCalledWith(9);
  });

  it('после reload восстанавливает ошибку и доступные действия из next.retry', async () => {
    const restored = task(4, 'Восстановленный вопрос');
    restored.progress = {
      total: 4, correct: 3, target: 12, done: false, lives: lives(1, true),
    };
    restored.retry = {
      attempt_id: 77,
      previous_answer: 'неверный ответ',
      answer: 'верный ответ',
      explain: 'Так работает правило.',
      joke: 'Попытка номер два уже разминается.',
      dispute_status: 'rejected',
    };
    const next = vi.fn().mockResolvedValue(restored);
    const api = apiWith({ next });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByText('Пока не сошлось')).toBeInTheDocument();
    expect(screen.getByDisplayValue('неверный ответ')).toBeInTheDocument();
    expect(screen.getByText('верный ответ')).toBeInTheDocument();
    expect(screen.getByText('Так работает правило.')).toBeInTheDocument();
    expect(screen.getByText('Попытка номер два уже разминается.')).toBeInTheDocument();
    expect(screen.getByText('Проверил ещё раз: эталон остаётся в силе.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Исправить ответ' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Следующее задание' })).toBeEnabled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('после reload блокирует исправление и пропуск, пока спор открыт', async () => {
    const restored = task(4, 'Вопрос со спором');
    restored.progress = {
      total: 4, correct: 3, target: 12, done: false, lives: lives(2, true),
    };
    restored.retry = {
      attempt_id: 78,
      previous_answer: 'мой ответ',
      answer: 'эталон',
      explain: 'Разбор.',
      joke: 'Шутка.',
      dispute_status: 'open',
    };
    const verdict = controlled<{ dispute_id: number; status: 'rejected' }>();
    const skipRetry = vi.fn();
    const api = apiWith({
      next: vi.fn().mockResolvedValue(restored),
      dispute: vi.fn(() => verdict.promise),
      skipRetry,
    });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByText('Разбираюсь. Это может занять пару минут…')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Исправить ответ' });
    const skip = screen.getByRole('button', { name: 'Следующее задание' });
    expect(retry).toBeDisabled();
    expect(skip).toBeDisabled();
    fireEvent.click(retry);
    fireEvent.click(skip);
    expect(skipRetry).not.toHaveBeenCalled();
    expect(api.dispute).toHaveBeenCalledWith(78);

    verdict.resolve({ dispute_id: 9, status: 'rejected' });
    expect(await screen.findByText('Проверил ещё раз: эталон остаётся в силе.')).toBeInTheDocument();
    expect(retry).toBeEnabled();
    expect(skip).toBeEnabled();
  });

  it('после подтверждённого спора начисляет XP и закрывает исправление', async () => {
    const first = task(1);
    first.progress.lives = lives(3, false);
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(first).mockReturnValue(deferred<NextTaskResponse>()),
      answer: vi.fn().mockResolvedValue(retryableWrong()),
      dispute: vi.fn().mockResolvedValue({
        dispute_id: 7,
        status: 'upheld',
        xp: 25,
        progress: {
          total: 1, correct: 1, target: 12, done: false, lives: lives(3, false),
        },
      }),
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Я всё-таки прав' }));

    expect(await screen.findByText('Ты был прав — баллы вернулись.')).toBeInTheDocument();
    expect(screen.getByText('Верно')).toBeInTheDocument();
    expect(screen.getByText('+25 XP')).toBeInTheDocument();
    expect(screen.getByText('Жизни: 3 из 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Исправить ответ' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Следующее задание' })).toBeEnabled();
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
    expect(next).toHaveBeenNthCalledWith(2, 9, 1);

    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '2' } });
    fireEvent.submit(screen.getByLabelText('Число').closest('form') as HTMLFormElement);
    expect(await screen.findByText('Верно')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Следующее задание' }));
    expect(await screen.findByRole('heading', { name: 'Следующее задание' })).toBeInTheDocument();
    expect(screen.getByLabelText('Прогресс: 1 из 12')).toBeInTheDocument();
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

  it('завершает достигший цели забег после перезагрузки', async () => {
    const api = apiWith({
      next: vi.fn(() => Promise.reject(
        new RunApiError('забег готов к завершению', 409, 'run-complete'),
      )),
      finish: vi.fn(() => Promise.resolve(finishSummary())),
    });
    render(<RunScreen runId={9} api={api} />);

    expect(await screen.findByRole('heading', { name: 'Вот что получилось' })).toBeInTheDocument();
    expect(api.finish).toHaveBeenCalledWith(9);
  });

  it('скрывает эталон у предварительно отмеченного ответа', async () => {
    const held = answer(false);
    held.integrity_check = true;
    delete held.answer;
    delete held.explain;
    delete held.joke;
    const api = apiWith({
      next: vi.fn().mockResolvedValueOnce(task(1)).mockReturnValue(deferred<NextTaskResponse>()),
      answer: vi.fn(() => Promise.resolve(held)),
    });
    render(<RunScreen runId={9} api={api} />);
    await screen.findByRole('heading', { name: 'Сколько будет 1 + 1?' });
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: 'Ff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByText('Ответ принят')).toBeInTheDocument();
    expect(screen.queryByText('Эталон')).not.toBeInTheDocument();
  });

  it('после фоновой проверки повторяет отмеченный вопрос и завершает забег', async () => {
    const retryTask = task(7, 'Найди значение переменной').task;
    const retryIntegrity = vi.fn(() => Promise.resolve({
      status: 'completed' as const,
      result: finishSummary(),
    }));
    const api = apiWith({
      next: vi.fn(() => Promise.reject(
        new RunApiError('забег готов к завершению', 409, 'run-complete'),
      )),
      finish: vi.fn(() => Promise.resolve({ status: 'checking' as const, flagged: 1 })),
      integrity: vi.fn(() => Promise.resolve({
        status: 'retry_required' as const,
        flagged: 1,
        remaining: 1,
        retry: { item_id: 12, task: retryTask },
      })),
      retryIntegrity,
    });
    render(<RunScreen runId={9} api={api} wait={() => Promise.resolve()} />);

    expect(await screen.findByRole('heading', { name: 'Реши этот вопрос ещё раз' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить повторный ответ' }));

    expect(await screen.findByRole('heading', { name: 'Вот что получилось' })).toBeInTheDocument();
    expect(retryIntegrity).toHaveBeenCalledWith(expect.objectContaining({
      runId: 9, itemId: 12, answer: '18',
    }));
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

  it('после task-defective пропускает сломанную карточку и показывает следующую', async () => {
    const next = vi.fn()
      .mockResolvedValueOnce(task(1, 'Сломанное задание'))
      .mockResolvedValueOnce(task(2, 'Исправное задание'))
      .mockReturnValue(deferred<NextTaskResponse>());
    const api = apiWith({
      next,
      answer: vi.fn(() => Promise.reject(
        new RunApiError('задание повреждено', 409, 'task-defective'),
      )),
    });
    render(<RunScreen runId={9} api={api} />);

    await screen.findByRole('heading', { name: 'Сломанное задание' });
    await waitFor(() => expect(next).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Число'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByRole('heading', { name: 'Исправное задание' })).toBeInTheDocument();
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

  it('не показывает ответ старого запроса после смены забега', async () => {
    const old = controlled<NextTaskResponse>();
    const firstApi = apiWith({ next: vi.fn(() => old.promise) });
    const secondApi = apiWith({ next: vi.fn(() => Promise.resolve(task(2, 'Новый забег'))) });
    const view = render(<RunScreen runId={1} api={firstApi} />);

    view.rerender(<RunScreen runId={2} api={secondApi} />);
    expect(await screen.findByRole('heading', { name: 'Новый забег' })).toBeInTheDocument();
    old.resolve(task(1, 'Старый забег'));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Старый забег' }))
      .not.toBeInTheDocument());
  });
});
