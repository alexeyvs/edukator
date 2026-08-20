import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  browserRunApi,
  RunApiError,
  type AnswerResponse,
  type DisputeStatus,
  type FinishRunResponse,
  type IntegrityStatusResponse,
  type NextTaskResponse,
  type RunApi,
  type RunProgress,
  type RunTask,
} from './run-api';
import { FinishScreen } from './FinishScreen';
import { LearningFinishScreen } from './LearningFinishScreen';
import {
  browserLearningApi,
  type FinishLearningResponse,
  type LearningApi,
} from './learning-api';
import { SafeRichText, TaskPrompt } from './TaskPrompt';
import { BrandLink } from './BrandMark';

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

/**
 * Старый процесс сервера мог вернуть внутренний IssuedTask из finish-маршрута.
 * Нормализуем его на клиенте, чтобы уже открытый забег пережил обновление кода.
 */
function normalizeIntegrityTask(task: RunTask): RunTask {
  const legacy = task as unknown as Record<string, unknown>;
  const materialFormat = task.material_format ?? legacy['materialFormat'];
  return {
    ...task,
    topic_id: task.topic_id ?? String(legacy['topicId'] ?? ''),
    topic_title: task.topic_title ?? String(legacy['topicTitle'] ?? ''),
    ...(materialFormat === undefined ? {} : {
      material_format: materialFormat as NonNullable<RunTask['material_format']>,
    }),
    answer_format: (task.answer_format ?? legacy['answerFormat'] ?? 'text') as RunTask['answer_format'],
  };
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
  const [retryAttemptId, setRetryAttemptId] = useState<number | undefined>();
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [problem, setProblem] = useState<ScreenProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disputeStatus, setDisputeStatus] = useState<DisputeStatus | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [finish, setFinish] = useState<FinishRunResponse | null>(null);
  const [learningFinish, setLearningFinish] = useState<FinishLearningResponse | null>(null);
  const [integrity, setIntegrity] = useState<Exclude<IntegrityStatusResponse, { status: 'completed' }> | null>(null);
  const shownAt = useRef(Date.now());
  const prefetched = useRef<NextTaskResponse | null>(null);
  const prefetching = useRef<Promise<void> | null>(null);
  const generation = useRef(0);

  const acceptIntegrity = useCallback((state: IntegrityStatusResponse): void => {
    if (state.status === 'completed') {
      setIntegrity(null);
      if (kind === 'lesson') setLearningFinish(state.result as unknown as FinishLearningResponse);
      else setFinish(state.result as unknown as FinishRunResponse);
      return;
    }
    const normalized = state.status === 'retry_required'
      ? { ...state, retry: { ...state.retry, task: normalizeIntegrityTask(state.retry.task) } }
      : state;
    setIntegrity(normalized);
    if (normalized.status === 'retry_required') {
      setAnswer('');
      setHintUsed(false);
      shownAt.current = Date.now();
    }
  }, [kind]);

  useEffect(() => {
    if (integrity?.status !== 'checking') return;
    let active = true;
    const token = generation.current;
    void wait(1_000).then(() => {
      if (api.integrity === undefined) throw new Error('Проверка ответов недоступна');
      return api.integrity(runId);
    }).then((state) => {
      if (active && generation.current === token) acceptIntegrity(state);
    }).catch((error: unknown) => {
      if (active && generation.current === token) setProblem(problemOf(error));
    });
    return () => { active = false; };
  }, [acceptIntegrity, api, integrity, runId, wait]);

  const pollDispute = useCallback(async (attemptId: number): Promise<void> => {
    const token = generation.current;
    setDisputing(true);
    let delay = DISPUTE_FIRST_DELAY_MS;
    try {
      while (generation.current === token) {
        const state = await api.dispute(attemptId);
        if (generation.current !== token) return;
        setDisputeStatus(state.status);
        if (state.progress != null) setProgress(state.progress);
        setResult((previous) => previous === null ? null : {
          ...previous,
          ...(state.status === 'upheld' ? { correct: true } : {}),
          ...(state.xp === undefined ? {} : { xp: state.xp }),
          ...(state.progress == null ? {} : { progress: state.progress }),
        });
        if (state.status !== 'open') return;
        await wait(delay);
        delay = Math.min(delay * 2, DISPUTE_MAX_DELAY_MS);
      }
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setDisputing(false);
    }
  }, [api, wait]);

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
    setAnswer(next.retry?.previous_answer ?? '');
    setHintUsed(false);
    setRetryAttemptId(undefined);
    setResult(next.retry === undefined ? null : {
      attempt_id: next.retry.attempt_id,
      correct: false,
      normalized: next.retry.previous_answer,
      answer: next.retry.answer,
      explain: next.retry.explain,
      joke: next.retry.joke,
      xp: 0,
      progress: actualProgress,
    });
    setDisputeStatus(next.retry?.dispute_status ?? null);
    setProblem(null);
    shownAt.current = Date.now();
    if (next.retry?.dispute_status === 'open') void pollDispute(next.retry.attempt_id);
    if (next.retry === undefined && actualProgress.total + 1 < actualProgress.target) {
      prefetchNext(next.task.id);
    }
  }, [pollDispute, prefetchNext]);

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
            if (generation.current === token) {
              if ('status' in summary) acceptIntegrity(summary);
              else setLearningFinish(summary);
            }
          } else {
            const summary = await api.finish(runId);
            if (generation.current === token) {
              if ('status' in summary) acceptIntegrity(summary);
              else setFinish(summary);
            }
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
  }, [acceptIntegrity, api, kind, learningApi, runId, showTask, wait]);

  useEffect(() => {
    generation.current += 1;
    const token = generation.current;
    prefetched.current = null;
    prefetching.current = null;
    setCurrent(null);
    setProgress(null);
    setFinish(null);
    setLearningFinish(null);
    setIntegrity(null);
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
        ...(retryAttemptId === undefined ? {} : { retryAttemptId }),
      });
      if (generation.current !== token) return;
      setRetryAttemptId(undefined);
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

  async function nextTask(actualProgress = progress): Promise<void> {
    const token = generation.current;
    if (prefetching.current !== null) await prefetching.current;
    if (generation.current !== token) return;
    const ready = prefetched.current;
    prefetched.current = null;
    if (ready !== null) {
      showTask(ready, actualProgress ?? ready.progress);
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
        if (generation.current === token) {
          if ('status' in summary) acceptIntegrity(summary);
          else setLearningFinish(summary);
        }
      } else {
        const summary = await api.finish(runId);
        if (generation.current === token) {
          if ('status' in summary) acceptIntegrity(summary);
          else setFinish(summary);
        }
      }
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  async function submitIntegrity(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (integrity?.status !== 'retry_required' || answer.trim() === '') return;
    const token = generation.current;
    setSubmitting(true);
    try {
      if (api.retryIntegrity === undefined) throw new Error('Повторная проверка недоступна');
      const state = await api.retryIntegrity({
        runId,
        itemId: integrity.retry.item_id,
        answer,
        durationMs: Math.max(0, Date.now() - shownAt.current),
        hintUsed,
      });
      if (generation.current === token) acceptIntegrity(state);
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  function retryAnswer(): void {
    if (result === null || disputeStatus === 'open' || disputing) return;
    setRetryAttemptId(result.attempt_id);
    setAnswer('');
    setResult(null);
    setDisputeStatus(null);
    shownAt.current = Date.now();
  }

  async function skipRetry(): Promise<void> {
    if (current === null || result === null || disputeStatus === 'open' || disputing) return;
    const token = generation.current;
    setSubmitting(true);
    try {
      const skipped = await api.skipRetry(runId, current.task.id);
      if (generation.current !== token) return;
      setProgress(skipped.progress);
      setRetryAttemptId(undefined);
      if (skipped.progress.done) await finishRun();
      else await nextTask(skipped.progress);
    } catch (error) {
      if (generation.current === token) setProblem(problemOf(error));
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  async function dispute(): Promise<void> {
    if (result === null || disputing) return;
    await pollDispute(result.attempt_id);
  }

  if (learningFinish !== null) return <LearningFinishScreen result={learningFinish} />;
  if (finish !== null) return <FinishScreen result={finish} />;
  if (problem !== null) return <Problem problem={problem} />;
  if (integrity?.status === 'checking') {
    return <main className="run-shell"><section className="run-card integrity-wait" role="status">
      <span className="integrity-mark" aria-hidden="true">⌁</span>
      <p className="finish-kicker">Проверка завершения</p>
      <h1>Проверяю все ответы</h1>
      <p>Вопросов в проверке: {integrity.flagged}. Забег зачтётся автоматически, если всё в порядке.</p>
    </section></main>;
  }
  if (integrity?.status === 'retry_required') {
    return <main className="run-shell">
      <header className="run-header integrity-header">
        <BrandLink label="На главный экран" />
        <div><span>Подтверждение решения</span><strong>Осталось вопросов: {integrity.remaining}</strong></div>
      </header>
      <section className="run-card integrity-retry" aria-labelledby="integrity-question">
        <p className="finish-kicker">Ответ выглядел случайным</p>
        <h1>Реши этот вопрос ещё раз</h1>
        <p className="integrity-copy">Правильный ответ пока скрыт. Спокойно реши задачу — учитывается новая попытка.</p>
        <form onSubmit={(event) => void submitIntegrity(event)}>
          <TaskPrompt
            task={integrity.retry.task}
            answer={answer}
            onAnswerChange={setAnswer}
            answerId="integrity-answer"
            headingId="integrity-question"
            hintVisible={hintUsed}
            {...(integrity.retry.task.hint === undefined ? {} : { hint: integrity.retry.task.hint })}
          />
          <div className="task-actions">
            {integrity.retry.task.hint !== undefined && (
              <button className="secondary" type="button" onClick={() => setHintUsed(true)} disabled={hintUsed}>
                {hintUsed ? 'Подсказка открыта' : 'Нужна подсказка'}
              </button>
            )}
            <button className="primary" type="submit" disabled={submitting || answer.trim() === ''}>
              {submitting ? 'Проверяю…' : 'Отправить повторный ответ'}
            </button>
          </div>
        </form>
      </section>
    </main>;
  }
  if (current === null || progress === null) {
    return <section className="run-card run-state" aria-label="Загрузка задания">Подбираю задание…</section>;
  }
  const lives = kind === 'run' ? progress.lives : undefined;

  return (
    <main className="run-shell">
      <header className="run-header">
        <BrandLink
          href={kind === 'lesson' && progress.total > 0 ? `/?runId=${runId}&kind=lesson` : '/'}
          label={kind === 'lesson' && progress.total > 0 ? 'Вернуться к тесту' : 'На главный экран'}
        />
        <div className="progress-block" aria-label={`Прогресс: ${progress.total} из ${progress.target}`}>
          <div className="progress-copy">
            <span>{kind === 'lesson' ? 'Проверка темы' : 'Забег'}</span>
            <strong>{progress.total} из {progress.target}</strong>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${Math.min(100, progress.total / progress.target * 100)}%` }} />
          </div>
        </div>
        {lives !== undefined && (
          <div className="lives-block" aria-label={`Жизни: ${lives.remaining} из ${lives.total}`}>
            <span className="lives-hearts" aria-hidden="true">
              {Array.from({ length: lives.total }, (_, index) => (
                <span className={index < lives.remaining ? 'life-full' : 'life-empty'} key={index}>
                  {index < lives.remaining ? '♥' : '♡'}
                </span>
              ))}
            </span>
            <span>Жизни: {lives.remaining} из {lives.total}</span>
          </div>
        )}
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
          {result.integrity_check === true ? (
            <div className="answer-result integrity-held">
              <p className="verdict">Ответ принят</p>
              <p>Пока не показываю эталон: этот ответ будет отдельно проверен при завершении занятия.</p>
              <div className="task-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={submitting}
                  onClick={() => void (
                    kind === 'run' && result.progress.lives?.retryAvailable === true
                      ? skipRetry()
                      : result.progress.done ? finishRun() : nextTask()
                  )}
                >
                  {result.progress.done
                    ? kind === 'lesson' ? 'Завершить тест' : 'Завершить забег'
                    : 'Следующее задание'}
                </button>
              </div>
            </div>
          ) : <div className={`answer-result ${result.correct ? 'correct' : 'wrong'}`}>
            <p className="verdict">{result.correct ? 'Верно' : 'Пока не сошлось'} <strong>+{result.xp} XP</strong></p>
            <dl>
              <div><dt>Эталон</dt><dd>{result.answer}</dd></div>
              <div><dt>Разбор</dt><dd><SafeRichText source={result.explain ?? ''} /></dd></div>
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
              {kind === 'run' && !result.correct && result.progress.lives?.retryAvailable === true && (
                <button
                  className="secondary"
                  type="button"
                  onClick={retryAnswer}
                  disabled={submitting || disputing || disputeStatus === 'open'}
                >
                  Исправить ответ
                </button>
              )}
              <button
                className="primary"
                type="button"
                disabled={submitting || disputing || disputeStatus === 'open'}
                onClick={() => void (
                  kind === 'run' && !result.correct && result.progress.lives?.retryAvailable === true
                    ? skipRetry()
                    : result.progress.done ? finishRun() : nextTask()
                )}
              >
                {kind === 'run' && !result.correct && result.progress.lives?.retryAvailable === true
                  ? 'Следующее задание'
                  : result.progress.done
                  ? kind === 'lesson' ? 'Завершить тест' : 'Завершить забег'
                  : 'Следующее задание'}
              </button>
            </div>
          </div>}
          </>
        )}
      </section>
    </main>
  );
}
