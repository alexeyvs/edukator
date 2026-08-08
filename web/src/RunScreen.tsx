import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  browserRunApi,
  RunApiError,
  type AnswerFormat,
  type AnswerResponse,
  type DisputeStatus,
  type NextTaskResponse,
  type RunApi,
  type RunProgress,
} from './run-api';

const NO_TASK_RETRY_MS = 2_000;
const DISPUTE_FIRST_DELAY_MS = 1_000;
const DISPUTE_MAX_DELAY_MS = 16_000;

type Wait = (delayMs: number) => Promise<void>;

export interface RunScreenProps {
  runId: number;
  api?: RunApi;
  wait?: Wait;
}

type ScreenProblem = 'restart' | 'no-topic' | 'no-task' | 'unknown';

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function problemOf(error: unknown): ScreenProblem {
  if (!(error instanceof RunApiError)) return 'unknown';
  if (error.code === 'no-topic') return 'no-topic';
  if (error.code === 'no-task') return 'no-task';
  if (error.code === 'restart-required' || error.status === 503) return 'restart';
  return 'unknown';
}

function inputDetails(format: AnswerFormat): { label: string; inputMode?: 'decimal'; placeholder: string } {
  if (format === 'number') {
    return { label: 'Число', inputMode: 'decimal', placeholder: 'Введи число' };
  }
  if (format === 'choice') {
    return { label: 'Вариант ответа', placeholder: 'Например, Б' };
  }
  return { label: 'Ответ', placeholder: 'Напиши ответ' };
}

function Problem({ problem }: { problem: ScreenProblem }) {
  const copy = {
    restart: ['Нужен перезапуск', 'База была заменена. Перезапусти Эдукатор и продолжим с этого места.'],
    'no-topic': ['На сегодня всё закрыто', 'Свободных тем больше нет — отличная точка, чтобы закончить занятие.'],
    'no-task': ['Очередь пуста', 'Задания подтягиваются. Попробую снова автоматически.'],
    unknown: ['Не получилось загрузить задание', 'Проверь соединение и попробуй ещё раз.'],
  }[problem];
  return (
    <section className="run-card run-state" role="alert">
      <span className="state-mark" aria-hidden="true">!</span>
      <h1>{copy[0]}</h1>
      <p>{copy[1]}</p>
    </section>
  );
}

export function RunScreen({ runId, api = browserRunApi, wait = defaultWait }: RunScreenProps) {
  const [current, setCurrent] = useState<NextTaskResponse | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [answer, setAnswer] = useState('');
  const [hintUsed, setHintUsed] = useState(false);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [problem, setProblem] = useState<ScreenProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disputeStatus, setDisputeStatus] = useState<DisputeStatus | null>(null);
  const [disputing, setDisputing] = useState(false);
  const shownAt = useRef(Date.now());
  const prefetched = useRef<NextTaskResponse | null>(null);
  const prefetching = useRef<Promise<void> | null>(null);
  const alive = useRef(true);

  const prefetchNext = useCallback((shownId: number): void => {
    prefetched.current = null;
    const pending = api.next(runId)
      .then((next) => {
        if (alive.current && next.task.id !== shownId) prefetched.current = next;
      })
      .catch(() => {
        // Предзагрузка — ускорение, а не второй источник ошибок на экране.
        // Если она не удалась, обычный переход запросит задание ещё раз.
      })
      .finally(() => {
        if (prefetching.current === pending) prefetching.current = null;
      });
    prefetching.current = pending;
  }, [api, runId]);

  const showTask = useCallback((next: NextTaskResponse): void => {
    setCurrent(next);
    setProgress(next.progress);
    setAnswer('');
    setHintUsed(false);
    setResult(null);
    setDisputeStatus(null);
    setProblem(null);
    shownAt.current = Date.now();
    prefetchNext(next.task.id);
  }, [prefetchNext]);

  const load = useCallback(async (): Promise<void> => {
    try {
      showTask(await api.next(runId));
    } catch (error) {
      if (!alive.current) return;
      const nextProblem = problemOf(error);
      setProblem(nextProblem);
      if (nextProblem === 'no-task') {
        await wait(NO_TASK_RETRY_MS);
        if (alive.current) void load();
      }
    }
  }, [api, runId, showTask, wait]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (current === null || answer.trim() === '') return;
    setSubmitting(true);
    try {
      const checked = await api.answer({
        runId,
        taskId: current.task.id,
        answer,
        hintUsed,
        durationMs: Math.max(0, Date.now() - shownAt.current),
      });
      if (!alive.current) return;
      setResult(checked);
      setProgress(checked.progress);
    } catch (error) {
      if (alive.current) setProblem(problemOf(error));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  async function nextTask(): Promise<void> {
    if (prefetching.current !== null) await prefetching.current;
    const ready = prefetched.current;
    prefetched.current = null;
    if (ready !== null) {
      showTask(ready);
      return;
    }
    await load();
  }

  async function dispute(): Promise<void> {
    if (result === null || disputing) return;
    setDisputing(true);
    let delay = DISPUTE_FIRST_DELAY_MS;
    try {
      while (alive.current) {
        const state = await api.dispute(result.attempt_id);
        if (!alive.current) return;
        setDisputeStatus(state.status);
        if (state.status !== 'open') return;
        await wait(delay);
        delay = Math.min(delay * 2, DISPUTE_MAX_DELAY_MS);
      }
    } catch (error) {
      if (alive.current) setProblem(problemOf(error));
    } finally {
      if (alive.current) setDisputing(false);
    }
  }

  if (problem !== null) return <Problem problem={problem} />;
  if (current === null || progress === null) {
    return <section className="run-card run-state" aria-label="Загрузка задания">Подбираю задание…</section>;
  }

  const details = inputDetails(current.task.answer_format);
  return (
    <main className="run-shell">
      <header className="run-header">
        <a className="brand" href="/" aria-label="На главный экран">Э</a>
        <div className="progress-block" aria-label={`Прогресс: ${progress.total} из ${progress.target}`}>
          <div className="progress-copy">
            <span>Забег</span>
            <strong>{progress.total} из {progress.target}</strong>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${Math.min(100, progress.total / progress.target * 100)}%` }} />
          </div>
        </div>
      </header>

      <section className="run-card" aria-labelledby="task-question">
        <div className="task-meta">
          <span>{current.task.topic_title}</span>
          <span>сложность {current.task.difficulty}</span>
        </div>
        <h1 id="task-question">{current.task.question}</h1>

        {result === null ? (
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="run-answer">{details.label}</label>
            <input
              id="run-answer"
              autoComplete="off"
              inputMode={details.inputMode}
              placeholder={details.placeholder}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            {hintUsed && <aside className="hint"><span>Подсказка</span>{current.task.hint}</aside>}
            <div className="task-actions">
              <button className="secondary" type="button" onClick={() => setHintUsed(true)} disabled={hintUsed}>
                {hintUsed ? 'Подсказка открыта' : 'Нужна подсказка'}
              </button>
              <button className="primary" type="submit" disabled={submitting || answer.trim() === ''}>
                {submitting ? 'Проверяю…' : 'Проверить'}
              </button>
            </div>
          </form>
        ) : (
          <div className={`answer-result ${result.correct ? 'correct' : 'wrong'}`}>
            <p className="verdict">{result.correct ? 'Верно' : 'Пока не сошлось'} <strong>+{result.xp} XP</strong></p>
            <dl>
              <div><dt>Эталон</dt><dd>{result.answer}</dd></div>
              <div><dt>Разбор</dt><dd>{result.explain}</dd></div>
              <div><dt>Напарник</dt><dd>{result.joke}</dd></div>
            </dl>
            {disputeStatus === 'open' && <p className="dispute-note">Разбираюсь. Это может занять пару минут…</p>}
            {disputeStatus === 'upheld' && <p className="dispute-note success">Ты был прав — баллы вернулись.</p>}
            {disputeStatus === 'rejected' && <p className="dispute-note">Проверил ещё раз: эталон остаётся в силе.</p>}
            <div className="task-actions">
              {!result.correct && disputeStatus === null && (
                <button className="secondary" type="button" onClick={() => void dispute()} disabled={disputing}>
                  Я всё-таки прав
                </button>
              )}
              <button className="primary" type="button" onClick={() => void nextTask()}>
                Следующее задание
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
