import { useCallback, useEffect, useReducer, useRef, type FormEvent } from 'react';
import {
  BossApiError,
  browserBossApi,
  type BossAnswerResponse,
  type BossApi,
  type NextBossTaskResponse,
} from './boss-api';
import { TaskPrompt } from './TaskPrompt';
import { BrandLink } from './BrandMark';

const BOSS_TARGET = 5;
const DISPUTE_FIRST_DELAY_MS = 1_000;
const DISPUTE_MAX_DELAY_MS = 16_000;

type Wait = (delayMs: number) => Promise<void>;
type BossScreenState =
  | { phase: 'rules' }
  | { phase: 'loading' }
  | { phase: 'victory' }
  | { phase: 'defeat' }
  | { phase: 'task'; current: NextBossTaskResponse; answer: string; submitting: boolean }
  | {
      phase: 'result'; current: NextBossTaskResponse; answer: string;
      result: BossAnswerResponse; submitting: boolean; disputing: boolean;
    }
  | { phase: 'mistake'; attemptId: number; completed: number; submitting: boolean; disputing: boolean }
  | { phase: 'problem'; message: string };

type BossScreenAction =
  | { type: 'show'; state: BossScreenState }
  | { type: 'answer'; value: string }
  | { type: 'submitting'; value: boolean }
  | { type: 'disputing'; value: boolean };

function reduceBossScreen(state: BossScreenState, action: BossScreenAction): BossScreenState {
  if (action.type === 'show') return action.state;
  if (action.type === 'answer' && state.phase === 'task') return { ...state, answer: action.value };
  if (action.type === 'submitting' &&
      (state.phase === 'task' || state.phase === 'result' || state.phase === 'mistake')) {
    return { ...state, submitting: action.value };
  }
  if (action.type === 'disputing' && (state.phase === 'result' || state.phase === 'mistake')) {
    return { ...state, disputing: action.value };
  }
  return state;
}

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
  const [screen, dispatch] = useReducer(reduceBossScreen, { phase: 'rules' });
  const shownAt = useRef(Date.now());
  const generation = useRef(0);

  const loadNext = useCallback(async (): Promise<void> => {
    const token = generation.current;
    dispatch({ type: 'show', state: { phase: 'loading' } });
    try {
      const current = await api.next(runId);
      if (generation.current !== token) return;
      shownAt.current = Date.now();
      dispatch({ type: 'show', state: { phase: 'task', current, answer: '', submitting: false } });
    } catch (error) {
      if (generation.current !== token) return;
      const unavailable = error instanceof BossApiError && (
        error.code === 'boss-not-ready' || error.code === 'boss-finished'
      );
      dispatch({
        type: 'show',
        state: {
          phase: 'problem',
          message: unavailable
            ? 'Этот бой сейчас недоступен. Новый набор заданий ещё готовится.'
            : error instanceof Error ? error.message : 'Не получилось загрузить бой',
        },
      });
    }
  }, [api, runId]);

  async function dispute(explicitAttemptId?: number): Promise<void> {
    const attemptId = explicitAttemptId ??
      (screen.phase === 'result' && !screen.result.correct ? screen.result.attemptId :
        screen.phase === 'mistake' ? screen.attemptId : undefined);
    const busy = (screen.phase === 'result' || screen.phase === 'mistake') &&
      (screen.submitting || screen.disputing);
    if (attemptId === undefined || busy) return;
    const token = generation.current;
    dispatch({ type: 'disputing', value: true });
    let delay = DISPUTE_FIRST_DELAY_MS;
    try {
      while (generation.current === token) {
        const state = await api.dispute(attemptId);
        if (generation.current !== token) return;
        if (state.status === 'upheld') {
          const fight = await api.state(runId);
          if (fight.outcome === 'won') {
            dispatch({ type: 'show', state: { phase: 'victory' } });
          } else {
            await loadNext();
          }
          return;
        }
        if (state.status === 'rejected') {
          dispatch({ type: 'show', state: { phase: 'defeat' } });
          return;
        }
        await wait(delay);
        delay = Math.min(delay * 2, DISPUTE_MAX_DELAY_MS);
      }
    } catch (error) {
      if (generation.current !== token) return;
      dispatch({
        type: 'show',
        state: {
          phase: 'problem',
          message: error instanceof Error ? error.message : 'Не получилось разобрать спор',
        },
      });
    } finally {
      if (generation.current === token) dispatch({ type: 'disputing', value: false });
    }
  }

  useEffect(() => {
    generation.current += 1;
    const token = generation.current;
    dispatch({ type: 'show', state: { phase: 'rules' } });
    void api.state(runId).then((state) => {
      if (generation.current !== token) return;
      if (state.outcome === 'won') dispatch({ type: 'show', state: { phase: 'victory' } });
      else if (state.outcome === 'lost') dispatch({ type: 'show', state: { phase: 'defeat' } });
      else if (state.outcome === 'mistake' || state.outcome === 'dispute') {
        dispatch({
          type: 'show',
          state: {
            phase: 'mistake', attemptId: state.attemptId, completed: state.progress.total,
            submitting: false, disputing: false,
          },
        });
        if (state.outcome === 'dispute') void dispute(state.attemptId);
      }
    }).catch((error: unknown) => {
      if (generation.current !== token) return;
      dispatch({
        type: 'show',
        state: {
          phase: 'problem',
          message: error instanceof Error ? error.message : 'Не получилось восстановить бой',
        },
      });
    });
    return () => { generation.current += 1; };
  }, [api, runId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (screen.phase !== 'task' || screen.answer.trim() === '' || screen.submitting) return;
    const { current, answer } = screen;
    const token = generation.current;
    dispatch({ type: 'submitting', value: true });
    try {
      const result = await api.answer({
        runId,
        taskId: current.task.id,
        answer,
        durationMs: Math.max(0, Date.now() - shownAt.current),
      });
      if (generation.current !== token) return;
      dispatch({
        type: 'show',
        state: result.outcome === 'won'
          ? { phase: 'victory' }
          : { phase: 'result', current, answer, result, submitting: false, disputing: false },
      });
    } catch (error) {
      if (generation.current !== token) return;
      dispatch({
        type: 'show',
        state: {
          phase: 'problem',
          message: error instanceof Error ? error.message : 'Не получилось проверить ответ',
        },
      });
    } finally {
      if (generation.current === token) dispatch({ type: 'submitting', value: false });
    }
  }

  async function concede(): Promise<void> {
    const busy = (screen.phase === 'result' || screen.phase === 'mistake') &&
      (screen.submitting || screen.disputing);
    if (busy) return;
    const token = generation.current;
    dispatch({ type: 'submitting', value: true });
    try {
      await api.concede(runId);
      if (generation.current === token) dispatch({ type: 'show', state: { phase: 'defeat' } });
    } catch (error) {
      if (generation.current !== token) return;
      dispatch({
        type: 'show',
        state: {
          phase: 'problem',
          message: error instanceof Error ? error.message : 'Не получилось завершить попытку',
        },
      });
    } finally {
      if (generation.current === token) dispatch({ type: 'submitting', value: false });
    }
  }

  if (screen.phase === 'rules') return <Rules onStart={() => void loadNext()} />;
  if (screen.phase === 'victory') return <Ending victory />;
  if (screen.phase === 'defeat') return <Ending victory={false} />;
  if (screen.phase === 'mistake') {
    return (
      <main className="run-card run-state boss-ending">
        <Progress completed={screen.completed} />
        <h1>Ответ не засчитан</h1>
        {screen.disputing && <p className="dispute-note" role="status">Разбираюсь. Ответить снова пока нельзя…</p>}
        <div className="task-actions">
          <button className="secondary" type="button" disabled={screen.submitting || screen.disputing} onClick={() => void dispute()}>Я всё-таки прав</button>
          <button className="primary" type="button" disabled={screen.submitting || screen.disputing} onClick={() => void concede()}>Признать поражение</button>
        </div>
      </main>
    );
  }
  if (screen.phase === 'problem') {
    return (
      <main className="run-card run-state" role="alert">
        <span className="state-mark" aria-hidden="true">!</span>
        <h1>Бой приостановлен</h1>
        <p>{screen.message}</p>
        <a className="primary boss-home-link" href="/">На главный экран</a>
      </main>
    );
  }
  if (screen.phase === 'loading') {
    return <main className="run-card run-state" aria-label="Загрузка босса">Готовлю арену…</main>;
  }

  const result = screen.phase === 'result' ? screen.result : null;
  const disputing = screen.phase === 'result' && screen.disputing;
  const completed = result?.progress.total ?? screen.current.position - 1;
  return (
    <main className="run-shell boss-shell">
      <header className="run-header">
        <BrandLink label="На главный экран" />
        <div className="progress-block">
          <div className="progress-copy"><span>Босс</span><strong>{completed} из {BOSS_TARGET}</strong></div>
          <Progress completed={completed} />
        </div>
      </header>
      <section className="run-card" aria-labelledby="boss-question">
        <div className="task-meta">
          <span>{screen.current.task.topic_title}</span>
          <span>задание {screen.current.position} из {BOSS_TARGET}</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <TaskPrompt
            task={screen.current.task}
            answer={screen.answer}
            onAnswerChange={(value) => dispatch({ type: 'answer', value })}
            answerId="boss-answer"
            headingId="boss-question"
            readOnly={screen.phase === 'result'}
          />
          {result === null ? (
            <div className="task-actions">
              <button className="primary" type="submit" disabled={screen.submitting || screen.answer.trim() === ''}>
                {screen.submitting ? 'Проверяю…' : 'Проверить'}
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
                    <button className="secondary" type="button" disabled={disputing || screen.submitting} onClick={() => void dispute()}>
                      Я всё-таки прав
                    </button>
                    <button className="primary" type="button" disabled={disputing || screen.submitting} onClick={() => void concede()}>
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
