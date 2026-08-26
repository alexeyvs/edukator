import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FinishScreen } from './FinishScreen';
import { SafeRichText, TaskPrompt } from './TaskPrompt';
import { BrandLink } from './BrandMark';
import {
  browserRunApi,
  RunApiError,
  type AnswerResponse,
  type DisputeStatus,
  type FinishRunResponse,
  type NextTriageResponse,
  type RunApi,
} from './run-api';

export interface TriageScreenProps {
  runId: number;
  api?: RunApi;
  wait?: (delayMs: number) => Promise<void>;
}

const DISPUTE_FIRST_DELAY_MS = 1_000;
const DISPUTE_MAX_DELAY_MS = 16_000;

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function TriageScreen({ runId, api = browserRunApi, wait = defaultWait }: TriageScreenProps) {
  const [next, setNext] = useState<Extract<NextTriageResponse, { status: 'ok' }> | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [finish, setFinish] = useState<FinishRunResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disputeStatus, setDisputeStatus] = useState<DisputeStatus | null>(null);
  const [disputing, setDisputing] = useState(false);
  const shownAt = useRef(Date.now());
  const generation = useRef(0);

  const finishTriage = useCallback(async (token = generation.current): Promise<void> => {
    setBusy(true);
    try {
      const summary = await api.finish(runId);
      // Каст держится на маршруте, а не на типе: проверку осмысленности
      // `POST /api/run/:id/finish` запускает только для `kind = 'run'`, а триажу
      // отвечает сводкой сразу. Копировать это глушение в новый экран нельзя —
      // на обычном забеге тот же каст отдаёт `FinishScreen` состояние проверки
      // вместо сводки, и экран падает в пустоту (см. `HomeScreen.continueRun`).
      if (generation.current === token) setFinish(summary as FinishRunResponse);
    } catch {
      if (generation.current === token) setProblem('Не получилось собрать итог триажа. Попробуй ещё раз.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }, [api, runId]);

  const load = useCallback(async (token = generation.current): Promise<void> => {
    setBusy(true);
    try {
      const response = await api.triageNext(runId);
      if (generation.current !== token) return;
      if (response.status === 'done') {
        await finishTriage(token);
        return;
      }
      setNext(response);
      setAnswer('');
      setResult(null);
      setDisputeStatus(null);
      shownAt.current = Date.now();
    } catch {
      if (generation.current === token) setProblem('Не получилось загрузить вопрос триажа. Попробуй ещё раз.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }, [api, finishTriage, runId]);

  useEffect(() => {
    generation.current += 1;
    const token = generation.current;
    setNext(null);
    setResult(null);
    setFinish(null);
    setProblem(null);
    setDisputeStatus(null);
    void load(token);
    return () => {
      if (generation.current === token) generation.current += 1;
    };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (next === null || answer.trim() === '') return;
    const token = generation.current;
    setBusy(true);
    try {
      const checked = await api.answer({
        runId,
        taskId: next.task.id,
        answer,
        hintUsed: false,
        durationMs: Math.max(0, Date.now() - shownAt.current),
      });
      if (generation.current === token) setResult(checked);
    } catch (error) {
      if (generation.current !== token) return;
      if (error instanceof RunApiError && error.code === 'task-defective') {
        await load(token);
      } else {
        setProblem('Не получилось проверить ответ. Попробуй ещё раз.');
      }
    } finally {
      if (generation.current === token) setBusy(false);
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
    } catch {
      if (generation.current === token) setProblem('Не получилось разобрать спор. Попробуй ещё раз.');
    } finally {
      if (generation.current === token) setDisputing(false);
    }
  }

  if (finish !== null) return <FinishScreen result={finish} kind="triage" />;
  if (problem !== null) return <section className="run-card run-state" role="alert">{problem}</section>;
  if (next === null) {
    return <section className="run-card run-state" aria-label="Загрузка триажа">Подбираю вопрос…</section>;
  }

  const progress = result?.progress ?? next.progress;
  return (
    <main className="run-shell triage-shell">
      <header className="run-header">
        <BrandLink label="На главный экран" />
        <div className="progress-block" aria-label={`Прогресс триажа: ${progress.total} из ${progress.target}`}>
          <div className="progress-copy"><span>Триаж</span><strong>{progress.total} из {progress.target}</strong></div>
          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${Math.min(100, progress.total / progress.target * 100)}%` }} />
          </div>
        </div>
      </header>

      <section className="run-card" aria-labelledby="triage-question">
        <div className="task-meta">
          <span>{next.task.topic_title}</span>
          <span>сложность {next.task.difficulty}</span>
        </div>
        {result === null ? (
          <form onSubmit={(event) => void submit(event)}>
            <TaskPrompt
              task={next.task}
              answer={answer}
              onAnswerChange={setAnswer}
              answerId="triage-answer"
              headingId="triage-question"
            />
            <div className="task-actions">
              <button className="primary" type="submit" disabled={busy || answer.trim() === ''}>
                {busy ? 'Проверяю…' : 'Проверить'}
              </button>
            </div>
          </form>
        ) : (
          <>
          <TaskPrompt
            task={next.task}
            answer={answer}
            onAnswerChange={setAnswer}
            answerId="triage-answer-result"
            headingId="triage-question"
            readOnly
          />
          <div className={`answer-result ${result.correct ? 'correct' : 'wrong'}`}>
            <p className="verdict"><span>{result.correct ? 'Верно' : 'Пока не сошлось'}</span> <strong>+{result.xp} XP</strong></p>
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
              <button
                className="primary"
                type="button"
                disabled={busy || disputing || disputeStatus === 'open'}
                onClick={() => void (result.progress.done ? finishTriage() : load())}
              >
                {result.progress.done ? 'Показать итог' : 'Следующий вопрос'}
              </button>
            </div>
          </div>
          </>
        )}
      </section>
    </main>
  );
}
