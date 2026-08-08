import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FinishScreen } from './FinishScreen';
import {
  browserRunApi,
  type AnswerResponse,
  type FinishRunResponse,
  type NextTriageResponse,
  type RunApi,
} from './run-api';

export interface TriageScreenProps {
  runId: number;
  api?: RunApi;
}

function answerLabel(format: 'number' | 'text' | 'choice'): string {
  if (format === 'number') return 'Число';
  if (format === 'choice') return 'Вариант ответа';
  return 'Ответ';
}

export function TriageScreen({ runId, api = browserRunApi }: TriageScreenProps) {
  const [next, setNext] = useState<Extract<NextTriageResponse, { status: 'ok' }> | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [finish, setFinish] = useState<FinishRunResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const generation = useRef(0);

  const finishTriage = useCallback(async (token = generation.current): Promise<void> => {
    setBusy(true);
    try {
      const summary = await api.finish(runId);
      if (generation.current === token) setFinish(summary);
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
    } catch {
      if (generation.current === token) setProblem('Не получилось проверить ответ. Попробуй ещё раз.');
    } finally {
      if (generation.current === token) setBusy(false);
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
        <a className="brand" href="/" aria-label="На главный экран">Э</a>
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
        <h1 id="triage-question">{next.task.question}</h1>
        {result === null ? (
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="triage-answer">{answerLabel(next.task.answer_format)}</label>
            <input
              id="triage-answer"
              autoComplete="off"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <div className="task-actions">
              <button className="primary" type="submit" disabled={busy || answer.trim() === ''}>
                {busy ? 'Проверяю…' : 'Проверить'}
              </button>
            </div>
          </form>
        ) : (
          <div className={`answer-result ${result.correct ? 'correct' : 'wrong'}`}>
            <p className="verdict">{result.correct ? 'Верно' : 'Пока не сошлось'}</p>
            <dl>
              <div><dt>Эталон</dt><dd>{result.answer}</dd></div>
              <div><dt>Разбор</dt><dd>{result.explain}</dd></div>
            </dl>
            <div className="task-actions">
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => void (result.progress.done ? finishTriage() : load())}
              >
                {result.progress.done ? 'Показать итог' : 'Следующий вопрос'}
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
