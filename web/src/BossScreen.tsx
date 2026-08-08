import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BossApiError,
  browserBossApi,
  type BossAnswerResponse,
  type BossApi,
  type NextBossTaskResponse,
} from './boss-api';
import { TaskPrompt } from './TaskPrompt';

const BOSS_TARGET = 5;
const DISPUTE_FIRST_DELAY_MS = 1_000;
const DISPUTE_MAX_DELAY_MS = 16_000;

type Wait = (delayMs: number) => Promise<void>;
type Phase = 'rules' | 'loading' | 'task' | 'result' | 'victory' | 'defeat' | 'problem';

export interface BossScreenProps {
  runId: number;
  api?: BossApi;
  wait?: Wait;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function Progress({ completed }: { completed: number }) {
  return (
    <div className="boss-progress" aria-label={`Прогресс босса: ${completed} из ${BOSS_TARGET}`}>
      {Array.from({ length: BOSS_TARGET }, (_, index) => (
        <span className={index < completed ? 'complete' : ''} key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

function Rules({ onStart }: { onStart: () => void }) {
  return (
    <main className="run-card run-state boss-rules">
      <span className="boss-kicker">Бой с боссом</span>
      <h1>Пять подряд — и тема закрыта</h1>
      <ul>
        <li>Нужно решить пять заданий подряд.</li>
        <li>Подсказок не будет.</li>
        <li>Одна ошибка завершает попытку.</li>
        <li>Таймера и жизней нет.</li>
      </ul>
      <button className="primary" type="button" onClick={onStart}>Начать бой</button>
    </main>
  );
}

function Ending({ victory }: { victory: boolean }) {
  return (
    <main className="run-card run-state boss-ending">
      <span className="state-mark" aria-hidden="true">{victory ? '✓' : '↻'}</span>
      <h1>{victory ? 'Босс побеждён' : 'Попытка завершена'}</h1>
      <p>{victory
        ? 'Пять из пяти. Тема закрыта окончательно и больше не вернётся в план.'
        : 'Никакого календарного наказания. Новый набор уже готовится — вернёшься к нему позже.'}</p>
      <a className="primary boss-home-link" href="/">На главный экран</a>
    </main>
  );
}

export function BossScreen({ runId, api = browserBossApi, wait = defaultWait }: BossScreenProps) {
  const [phase, setPhase] = useState<Phase>('rules');
  const [current, setCurrent] = useState<NextBossTaskResponse | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<BossAnswerResponse | null>(null);
  const [problem, setProblem] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const shownAt = useRef(Date.now());
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setPhase('rules');
    setCurrent(null);
    setResult(null);
    setAnswer('');
    setProblem('');
    return () => { generation.current += 1; };
  }, [runId]);

  const loadNext = useCallback(async (): Promise<void> => {
    const token = generation.current;
    setPhase('loading');
    setProblem('');
    try {
      const next = await api.next(runId);
      if (generation.current !== token) return;
      setCurrent(next);
      setAnswer('');
      setResult(null);
      shownAt.current = Date.now();
      setPhase('task');
    } catch (error) {
      if (generation.current !== token) return;
      const unavailable = error instanceof BossApiError && (
        error.code === 'boss-not-ready' || error.code === 'boss-finished'
      );
      setProblem(unavailable
        ? 'Этот бой сейчас недоступен. Новый набор заданий ещё готовится.'
        : error instanceof Error ? error.message : 'Не получилось загрузить бой');
      setPhase('problem');
    }
  }, [api, runId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (phase !== 'task' || current === null || answer.trim() === '' || submitting) return;
    const token = generation.current;
    setSubmitting(true);
    try {
      const checked = await api.answer({
        runId,
        taskId: current.task.id,
        answer,
        durationMs: Math.max(0, Date.now() - shownAt.current),
      });
      if (generation.current !== token) return;
      setResult(checked);
      setPhase(checked.outcome === 'won' ? 'victory' : 'result');
    } catch (error) {
      if (generation.current !== token) return;
      setProblem(error instanceof Error ? error.message : 'Не получилось проверить ответ');
      setPhase('problem');
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  async function dispute(): Promise<void> {
    if (result === null || result.correct || disputing) return;
    const token = generation.current;
    setDisputing(true);
    let delay = DISPUTE_FIRST_DELAY_MS;
    try {
      while (generation.current === token) {
        const state = await api.dispute(result.attemptId);
        if (generation.current !== token) return;
        if (state.status === 'upheld') {
          await loadNext();
          return;
        }
        if (state.status === 'rejected') {
          setPhase('defeat');
          return;
        }
        await wait(delay);
        delay = Math.min(delay * 2, DISPUTE_MAX_DELAY_MS);
      }
    } catch (error) {
      if (generation.current !== token) return;
      setProblem(error instanceof Error ? error.message : 'Не получилось разобрать спор');
      setPhase('problem');
    } finally {
      if (generation.current === token) setDisputing(false);
    }
  }

  async function concede(): Promise<void> {
    if (submitting || disputing) return;
    const token = generation.current;
    setSubmitting(true);
    try {
      await api.concede(runId);
      if (generation.current === token) setPhase('defeat');
    } catch (error) {
      if (generation.current !== token) return;
      setProblem(error instanceof Error ? error.message : 'Не получилось завершить попытку');
      setPhase('problem');
    } finally {
      if (generation.current === token) setSubmitting(false);
    }
  }

  if (phase === 'rules') return <Rules onStart={() => void loadNext()} />;
  if (phase === 'victory') return <Ending victory />;
  if (phase === 'defeat') return <Ending victory={false} />;
  if (phase === 'problem') {
    return (
      <main className="run-card run-state" role="alert">
        <span className="state-mark" aria-hidden="true">!</span>
        <h1>Бой приостановлен</h1>
        <p>{problem}</p>
        <a className="primary boss-home-link" href="/">На главный экран</a>
      </main>
    );
  }
  if (phase === 'loading' || current === null) {
    return <main className="run-card run-state" aria-label="Загрузка босса">Готовлю арену…</main>;
  }

  const completed = result?.progress.total ?? current.position - 1;
  return (
    <main className="run-shell boss-shell">
      <header className="run-header">
        <a className="brand" href="/" aria-label="На главный экран">Э</a>
        <div className="progress-block">
          <div className="progress-copy"><span>Босс</span><strong>{completed} из {BOSS_TARGET}</strong></div>
          <Progress completed={completed} />
        </div>
      </header>
      <section className="run-card" aria-labelledby="boss-question">
        <div className="task-meta">
          <span>{current.task.topic_title}</span>
          <span>задание {current.position} из {BOSS_TARGET}</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <TaskPrompt
            task={current.task}
            answer={answer}
            onAnswerChange={setAnswer}
            answerId="boss-answer"
            headingId="boss-question"
            readOnly={phase === 'result' || disputing}
          />
          {result === null ? (
            <div className="task-actions">
              <button className="primary" type="submit" disabled={submitting || answer.trim() === ''}>
                {submitting ? 'Проверяю…' : 'Проверить'}
              </button>
            </div>
          ) : (
            <div className={`answer-result ${result.correct ? 'correct' : 'wrong'}`}>
              <p className="verdict">{result.correct ? 'Верно' : 'Ошибка'} <strong>+{result.xp} XP</strong></p>
              {result.correct ? (
                <div className="task-actions">
                  <button className="primary" type="button" onClick={() => void loadNext()}>Дальше</button>
                </div>
              ) : (
                <>
                  {disputing && <p className="dispute-note" role="status">Разбираюсь. Ответить снова пока нельзя…</p>}
                  <div className="task-actions">
                    <button className="secondary" type="button" disabled={disputing || submitting} onClick={() => void dispute()}>
                      Я всё-таки прав
                    </button>
                    <button className="primary" type="button" disabled={disputing || submitting} onClick={() => void concede()}>
                      Признать поражение
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
