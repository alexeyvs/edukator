import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  browserRunApi,
  RunApiError,
  type AnswerResponse,
  type DisputeStatus,
  type FinishRunResponse,
  type NextTaskResponse,
  type RunApi,
  type RunProgress,
} from './run-api';
import { FinishScreen } from './FinishScreen';
import { LearningFinishScreen } from './LearningFinishScreen';
import {
  browserLearningApi,
  type FinishLearningResponse,
  type LearningApi,
} from './learning-api';
import { TaskPrompt } from './TaskPrompt';

const NO_TASK_RETRY_MS = 2_000;
const DISPUTE_FIRST_DELAY_MS = 1_000;
const DISPUTE_MAX_DELAY_MS = 16_000;

type Wait = (delayMs: number) => Promise<void>;

export interface RunScreenProps {
  runId: number;
  api?: RunApi;
  learningApi?: Pick<LearningApi, 'finish'>;
  kind?: 'run' | 'lesson';
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

export function RunScreen({
  runId,
  api = browserRunApi,
  learningApi = browserLearningApi,
  kind = 'run',
  wait = defaultWait,
}: RunScreenProps) {
  const [current, setCurrent] = useState<NextTaskResponse | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [answer, setAnswer] = useState('');
  const [hintUsed, setHintUsed] = useState(false);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [problem, setProblem] = useState<ScreenProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disputeStatus, setDisputeStatus] = useState<DisputeStatus | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [finish, setFinish] = useState<FinishRunResponse | null>(null);
  const [learningFinish, setLearningFinish] = useState<FinishLearningResponse | null>(null);
  const shownAt = useRef(Date.now());
  const prefetched = useRef<NextTaskResponse | null>(null);
  const prefetching = useRef<Promise<void> | null>(null);
  const generation = useRef(0);

  const prefetchNext = useCallback((shownId: number, token = generation.current): void => {
    prefetched.current = null;
    const pending = api.next(runId, shownId)
      .then((next) => {
        if (generation.current === token && next.task.id !== shownId) prefetched.current = next;
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

  const showTask = useCallback((next: NextTaskResponse, actualProgress = next.progress): void => {
    const shown = { ...next, progress: actualProgress };
    setCurrent(shown);
    setProgress(actualProgress);
    setAnswer('');
    setHintUsed(false);
    setResult(null);
    setDisputeStatus(null);
    setProblem(null);
    shownAt.current = Date.now();
    if (actualProgress.total + 1 < actualProgress.target) prefetchNext(next.task.id);
  }, [prefetchNext]);

  const load = useCallback(async (token = generation.current): Promise<void> => {
    try {
      const next = await api.next(runId);
      if (generation.current !== token) return;
      showTask(next);
    } catch (error) {
      if (generation.current !== token) return;
      if (error instanceof RunApiError && error.code === 'run-complete') {
        try {
          if (kind === 'lesson') {
            const summary = await learningApi.finish(runId);
            if (generation.current === token) setLearningFinish(summary);
          } else {
            const summary = await api.finish(runId);
            if (generation.current === token) setFinish(summary);
          }
        } catch (finishError) {
          if (generation.current === token) setProblem(problemOf(finishError));
        }
        return;
      }
      const nextProblem = problemOf(error);
      setProblem(nextProblem);
      if (nextProblem === 'no-task') {
        await wait(NO_TASK_RETRY_MS);
        if (generation.current === token) void load(token);
      }
    }
  }, [api, kind, learningApi, runId, showTask, wait]);

  useEffect(() => {
    generation.current += 1;
    const token = generation.current;
    prefetched.current = null;
    prefetching.current = null;
    setCurrent(null);
    setProgress(null);
    setFinish(null);
    setLearningFinish(null);
    setProblem(null);
    void load(token);
    return () => {
      if (generation.current === token) generation.current += 1;
    };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (current === null || answer.trim() === '') return;
    const token = generation.current;
    setSubmitting(true);
    try {
      const checked = await api.answer({
        runId,
        taskId: current.task.id,
        answer,
        hintUsed,
        durationMs: Math.max(0, Date.now() - shownAt.current),
      });
      if (generation.current !== token) return;
      setResult(checked);
      setProgress(checked.progress);
    } catch (error) {
      if (generation.current !== token) return;
      if (error instanceof RunApiError && error.code === 'task-defective') {
        // Сервер уже исключил сломанное задание из дальнейшей выдачи. Не
        // оставляем ученика на карточке, которую невозможно отправить снова.
        await nextTask();
      } else {
        setProblem(problemOf(error));
      }
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  async function nextTask(): Promise<void> {
    const token = generation.current;
    if (prefetching.current !== null) await prefetching.current;
    if (generation.current !== token) return;
    const ready = prefetched.current;
    prefetched.current = null;
    if (ready !== null) {
      showTask(ready, progress ?? ready.progress);
      return;
    }
    await load(token);
  }

  async function finishRun(): Promise<void> {
    const token = generation.current;
    setSubmitting(true);
    try {
      if (kind === 'lesson') {
        const summary = await learningApi.finish(runId);
        if (generation.current === token) setLearningFinish(summary);
      } else {
        const summary = await api.finish(runId);
        if (generation.current === token) setFinish(summary);
      }
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  async function dispute(): Promise<void> {
    if (result === null || disputing) return;
    const token = generation.current;
    setDisputing(true);
    let delay = DISPUTE_FIRST_DELAY_MS;
    try {
      while (generation.current === token) {
        const state = await api.dispute(result.attempt_id);
        if (generation.current !== token) return;
        setDisputeStatus(state.status);
        if (state.status !== 'open') return;
        await wait(delay);
        delay = Math.min(delay * 2, DISPUTE_MAX_DELAY_MS);
      }
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setDisputing(false);
    }
  }

  if (learningFinish !== null) return <LearningFinishScreen result={learningFinish} />;
  if (finish !== null) return <FinishScreen result={finish} />;
  if (problem !== null) return <Problem problem={problem} />;
  if (current === null || progress === null) {
    return <section className="run-card run-state" aria-label="Загрузка задания">Подбираю задание…</section>;
  }

  return (
    <main className="run-shell">
      <header className="run-header">
        <a
          className="brand"
          href={kind === 'lesson' && progress.total > 0 ? `/?runId=${runId}&kind=lesson` : '/'}
          aria-label={kind === 'lesson' && progress.total > 0 ? 'Вернуться к тесту' : 'На главный экран'}
        >Э</a>
        <div className="progress-block" aria-label={`Прогресс: ${progress.total} из ${progress.target}`}>
          <div className="progress-copy">
            <span>{kind === 'lesson' ? 'Проверка темы' : 'Забег'}</span>
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
        {result === null ? (
          <form onSubmit={(event) => void submit(event)}>
            <TaskPrompt
              task={current.task}
              answer={answer}
              onAnswerChange={setAnswer}
              answerId="run-answer"
              headingId="task-question"
              {...(kind === 'lesson' ? {} : { hint: current.task.hint, hintVisible: hintUsed })}
            />
            <div className="task-actions">
              {kind !== 'lesson' && (
                <button className="secondary" type="button" onClick={() => setHintUsed(true)} disabled={hintUsed}>
                  {hintUsed ? 'Подсказка открыта' : 'Нужна подсказка'}
                </button>
              )}
              <button className="primary" type="submit" disabled={submitting || answer.trim() === ''}>
                {submitting ? 'Проверяю…' : 'Проверить'}
              </button>
            </div>
          </form>
        ) : (
          <>
          <TaskPrompt
            task={current.task}
            answer={answer}
            onAnswerChange={setAnswer}
            answerId="run-answer-result"
            headingId="task-question"
            readOnly
            {...(kind === 'lesson' ? {} : { hint: current.task.hint, hintVisible: hintUsed })}
          />
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
              <button
                className="primary"
                type="button"
                disabled={submitting || disputing || disputeStatus === 'open'}
                onClick={() => void (result.progress.done ? finishRun() : nextTask())}
              >
                {result.progress.done
                  ? kind === 'lesson' ? 'Завершить тест' : 'Завершить забег'
                  : 'Следующее задание'}
              </button>
            </div>
          </div>
          </>
        )}
      </section>
    </main>
  );
}
