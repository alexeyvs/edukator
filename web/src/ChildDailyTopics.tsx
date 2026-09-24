import { useEffect, useState, type FormEvent } from 'react';
import type { FamilyCourse } from './family-api';
import { parentsApiFor, type ParentsRunDetail } from './parents-api';
import {
  browserDailyTopicsApi, type DailyTopicInput, type DailyTopicSet,
  type DailyTopicState, type DailyTopicsApi,
} from './daily-topics-api';

function FirstMistakes({ childId, runId }: { childId: string; runId: number }) {
  const [detail, setDetail] = useState<ParentsRunDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return <details onToggle={(event) => {
    if (event.currentTarget.open && detail === null) {
      void parentsApiFor(childId).readRun(runId).then(setDetail)
        .catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'Не удалось загрузить ответы'));
    }
  }}>
    <summary>Ошибки первой попытки</summary>
    {problem !== null && <p role="alert">{problem}</p>}
    {detail === null && problem === null && <p>Загружаю ответы…</p>}
    {detail !== null && (detail.attempts.filter((attempt) => attempt.current && !attempt.correct).length === 0
      ? <p>Ошибок не было.</p>
      : <ol>{detail.attempts.filter((attempt) => attempt.current && !attempt.correct).map((attempt) =>
        <li key={attempt.number}>
          <strong>{attempt.question}</strong>
          <p>Ответ ребёнка: {attempt.studentAnswer}. Верный ответ: {attempt.correctAnswer}.</p>
          <p>{attempt.explanation}</p>
        </li>)}</ol>)}
  </details>;
}

function SetStatus({ set, courses, childId }: { set: DailyTopicSet; courses: FamilyCourse[]; childId: string }) {
  const passed = set.items.filter((item) => item.materialStatus === 'passed').length;
  return <div className="daily-topic-set">
    <strong>{set.status === 'active' ? 'Действует сегодня' : 'Готовится замена'} · {passed}/{set.items.length} зачтено</strong>
    <p className="daily-topic-source">Исходный список: {set.sourceText}</p>
    <ol>{set.items.map((item) => <li key={item.id}>
      <span>{courses.find((course) => course.courseId === item.subject)?.title ?? item.subjectTitle} · {item.title}</span>
      <small>{item.materialStatus === 'passed' ? 'Зачтено'
        : item.status === 'error' ? `Ошибка: ${item.lastError ?? 'подготовка не удалась'}`
          : item.status === 'ready' ? 'Готово' : 'Готовится'}
      {item.firstTotal !== null && ` · первая попытка ${item.firstScore}/${item.firstTotal}`}</small>
      {item.firstRunId !== null && <FirstMistakes childId={childId} runId={item.firstRunId} />}
    </li>)}</ol>
  </div>;
}

export function ChildDailyTopics({
  childId,
  courses,
  api = browserDailyTopicsApi,
}: {
  childId: string;
  courses: FamilyCourse[];
  api?: DailyTopicsApi;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DailyTopicState | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<DailyTopicInput[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const refresh = (): void => {
      void api.read(childId).then((value) => {
        if (current) setState(value);
      }).catch((error: unknown) => {
        if (current) setProblem(error instanceof Error ? error.message : 'Не получилось обновить темы');
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [api, childId, open]);

  async function inspect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setPreview(await api.preview(childId, text));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось разобрать темы');
    } finally {
      setBusy(false);
    }
  }

  function edit(index: number, patch: Partial<DailyTopicInput>): void {
    setPreview((items) => items?.map((item, current) => current === index ? { ...item, ...patch } : item) ?? null);
  }

  async function confirm(): Promise<void> {
    if (busy || preview === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.confirm(childId, text, crypto.randomUUID(), preview);
      setState(await api.read(childId));
      setPreview(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось назначить темы');
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: 'retry' | 'cancel'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setState(kind === 'retry' ? await api.retry(childId) : await api.cancel(childId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось изменить назначение');
    } finally {
      setBusy(false);
    }
  }

  return <details className="family-daily-topics" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Темы из школы на сегодня</summary>
    <p>Вставьте темы по одной на строку. Для каждой подготовим разбор и тест; доступ откроется после зачёта всех тем.</p>
    <p>Большой список может готовиться долго. После полуночи по Москве назначение сегодня не включится.</p>
    {state?.active !== null && state?.active !== undefined && <SetStatus set={state.active} courses={courses} childId={childId} />}
    {state?.preparing !== null && state?.preparing !== undefined && <SetStatus set={state.preparing} courses={courses} childId={childId} />}
    {state?.preparing?.items.some((item) => item.status === 'error') &&
      <button type="button" className="secondary" disabled={busy} onClick={() => void act('retry')}>Повторить ошибки подготовки</button>}
    {(state?.active !== null || state?.preparing !== null) && state !== null &&
      <button type="button" className="secondary" disabled={busy} onClick={() => void act('cancel')}>Отменить темы на сегодня</button>}
    <form onSubmit={(event) => { void inspect(event); }}>
      <label htmlFor={`daily-topic-text-${childId}`}>Список тем</label>
      <textarea id={`daily-topic-text-${childId}`} value={text}
        onChange={(event) => { setText(event.target.value); setPreview(null); }} rows={5} />
      <button type="submit" disabled={busy || text.trim() === ''}>{busy ? 'Разбираю…' : 'Разобрать список'}</button>
    </form>
    {preview !== null && <section className="daily-topic-preview" aria-label="Проверка тем">
      <h4>Проверьте темы и предметы</h4>
      <ol>{preview.map((item, index) => <li key={index}>
        {preview.some((other, otherIndex) => otherIndex < index &&
          other.title.trim().toLocaleLowerCase('ru-RU') === item.title.trim().toLocaleLowerCase('ru-RU') &&
          other.subjectId === item.subjectId && other.subjectTitle === item.subjectTitle) &&
          <small role="note">Похоже на повтор темы. Проверьте, нужны ли оба пункта.</small>}
        <label>Тема
          <input value={item.title} onChange={(event) => edit(index, { title: event.target.value, topicId: null })} />
        </label>
        <label>Предмет
          <select value={item.subjectId ?? ''} onChange={(event) => {
            const selected = courses.find((course) => course.courseId === event.target.value);
            edit(index, {
              subjectId: selected?.courseId ?? null,
              subjectTitle: selected?.title ?? item.subjectTitle,
              topicId: null,
            });
          }}>
            <option value="">Личный предмет</option>
            {courses.map((course) => <option value={course.courseId} key={course.courseId}>{course.title}</option>)}
          </select>
        </label>
        {item.subjectId === null
          ? <label>Название предмета<input value={item.subjectTitle}
              onChange={(event) => edit(index, { subjectTitle: event.target.value })} /></label>
          : <label>Тема курса
              <select value={item.topicId ?? ''} onChange={(event) => edit(index, { topicId: event.target.value || null })}>
                <option value="">Новая личная тема</option>
                {courses.find((course) => course.courseId === item.subjectId)?.topics.map((topic) =>
                  <option key={topic.id} value={topic.id}>{topic.title}</option>) }
              </select>
            </label>}
      </li>)}</ol>
      <button type="button" disabled={busy} onClick={() => void confirm()}>Назначить все темы</button>
    </section>}
    {problem !== null && <p className="auth-message error" role="alert">{problem}</p>}
  </details>;
}
