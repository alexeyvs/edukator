import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  browserAdminApi,
  type AdminApi,
  type AdminCourseCard,
  type AdminCourseDraft,
  type AdminCourseSource,
  type AdminDraftTopicInput,
  type AdminSourceProcessingStatus,
} from '../admin-api';
import { HttpError } from '../http';
import type { AdminSignOutReason } from './AdminHomeScreen';

type EditableTopic = AdminDraftTopicInput & { key: string };

function message(error: unknown, fallback: string): string {
  if (error instanceof HttpError && error.status === 409) {
    return `Конфликт: ${error.message}. Обновите данные и повторите изменение.`;
  }
  return error instanceof Error ? error.message : fallback;
}

function editableTopics(draft: AdminCourseDraft): EditableTopic[] {
  return draft.topics.map((topic) => ({ ...topic, key: topic.id }));
}

function StatusPages({ status }: { status: AdminSourceProcessingStatus | undefined }) {
  if (status === undefined) return <p className="admin-empty">Диагностика страниц ещё не загружена</p>;
  return (
    <div className="admin-source-preview">
      <p>
        OCR: {status.job?.status ?? status.sourceStatus}
        {status.job?.currentPage === null || status.job?.currentPage === undefined
          ? '' : ` · страница ${String(status.job.currentPage)}`}
      </p>
      {status.job?.error !== null && status.job?.error !== undefined && <p role="alert">{status.job.error}</p>}
      <ol aria-label="Страницы-основания">
        {status.pages.map((page) => (
          <li className={`is-${page.status}`} key={page.pageNumber}>
            <strong>{page.pageNumber}</strong><span>{page.status}</span>
            {page.error !== null && <small>{page.error}</small>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function AdminCourseEditor({
  api = browserAdminApi,
  courseId,
  onBack,
  onSignedOut,
}: {
  api?: AdminApi;
  courseId: string;
  onBack: () => void;
  onSignedOut: (reason: AdminSignOutReason) => void;
}) {
  const [card, setCard] = useState<AdminCourseCard | null>(null);
  const [draft, setDraft] = useState<AdminCourseDraft | null>(null);
  const [sources, setSources] = useState<AdminCourseSource[]>([]);
  const [sourceStatus, setSourceStatus] = useState<Record<number, AdminSourceProcessingStatus>>({});
  const [buildStatus, setBuildStatus] = useState<string>('не запускалась');
  const [topics, setTopics] = useState<EditableTopic[]>([]);
  const [title, setTitle] = useState('');
  const [grade, setGrade] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const fail = useCallback((error: unknown, fallback: string) => {
    if (error instanceof HttpError && error.status === 401) onSignedOut('expired');
    else setProblem(message(error, fallback));
  }, [onSignedOut]);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [loadedCard, loadedSources] = await Promise.all([api.course(courseId), api.courseSources(courseId)]);
      const foundDraft = loadedCard.revisions.find((revision) => revision.status === 'draft');
      setCard(loadedCard);
      setTitle(loadedCard.course.title);
      setGrade(loadedCard.course.grade);
      setSources(loadedSources.sources);
      if (foundDraft === undefined) {
        setDraft(null);
        setTopics([]);
        setBuildStatus('нет черновика');
      } else {
        const loadedDraft = { revision: foundDraft, topics: foundDraft.topics };
        setDraft(loadedDraft);
        setTopics(editableTopics(loadedDraft));
        void api.courseBuild(courseId).then(({ job }) => setBuildStatus(job?.status ?? 'не запускалась'))
          .catch(() => setBuildStatus('состояние недоступно'));
      }
      const statuses = await Promise.all(loadedSources.sources.map(async (source) => {
        try { return [source.id, await api.courseSourceStatus(courseId, source.id)] as const; }
        catch { return null; }
      }));
      setSourceStatus(Object.fromEntries(statuses.filter((item) => item !== null)));
    } catch (error: unknown) {
      fail(error, 'Не получилось загрузить курс');
    }
  }, [api, courseId, fail]);

  useEffect(() => { void load(); }, [attempt, load]);

  useEffect(() => {
    const activeSources = sources.filter((source) => source.status === 'uploaded' || source.status === 'processing');
    if (activeSources.length === 0 && buildStatus !== 'running' && buildStatus !== 'queued') return undefined;
    const timer = window.setInterval(() => {
      for (const source of activeSources) {
        void api.courseSourceStatus(courseId, source.id).then((status) => {
          setSourceStatus((all) => ({ ...all, [source.id]: status }));
          if (status.sourceStatus === 'ready' || status.sourceStatus === 'failed') {
            setSources((all) => all.map((item) => item.id === source.id
              ? { ...item, status: status.sourceStatus as AdminCourseSource['status'] } : item));
          }
        }).catch(() => undefined);
      }
      if (buildStatus === 'running' || buildStatus === 'queued') {
        void api.courseBuild(courseId).then(({ job }) => setBuildStatus(job?.status ?? 'не запускалась'))
          .catch(() => undefined);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [api, buildStatus, courseId, sources]);

  const sourceReady = sources.every((source) => source.status === 'ready');
  const publishBlocked = draft === null || !sourceReady || buildStatus === 'running' || buildStatus === 'failed';
  const revisionLabels = useMemo(() => card?.revisions.map((revision) =>
    `Редакция ${String(revision.revisionNumber)} — ${revision.status === 'draft' ? 'черновик' : 'опубликована'}`) ?? [], [card]);

  async function saveMetadata(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft === null) return;
    setBusy('metadata'); setProblem(null); setNotice(null);
    try {
      const result = await api.updateCourse(courseId, {
        revisionId: draft.revision.id, editVersion: draft.revision.editVersion,
        title: title.trim(), grade: grade.trim(),
      });
      setCard((current) => current === null ? current : { ...current, course: result.course });
      setDraft((current) => current === null ? current : { ...current, revision: result.revision });
      setNotice('Метаданные сохранены');
    } catch (error: unknown) { fail(error, 'Не получилось сохранить метаданные'); }
    setBusy(null);
  }

  async function saveTopics(): Promise<void> {
    if (draft === null) return;
    setBusy('topics'); setProblem(null); setNotice(null);
    try {
      const saved = await api.replaceCourseTopics(courseId, {
        revisionId: draft.revision.id,
        editVersion: draft.revision.editVersion,
        topics: topics.map(({ key: _key, ...topic }) => topic),
      });
      setDraft(saved); setTopics(editableTopics(saved)); setNotice('Карта тем сохранена');
    } catch (error: unknown) { fail(error, 'Не получилось сохранить темы'); }
    setBusy(null);
  }

  function changeTopic(key: string, patch: Partial<EditableTopic>): void {
    setTopics((items) => items.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  function addTopic(): void {
    const token = `new-${String(Date.now())}-${String(topics.length + 1)}`;
    setTopics((items) => [...items, {
      key: token, clientId: token, title: '', examWeight: 1, difficulty: 1,
      prereqs: [], answerFormat: 'text', promptSeed: '', active: true,
    }]);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setBusy('upload'); setProblem(null); setNotice(null);
    try {
      const result = await api.uploadCourseSource(courseId, file);
      setNotice(result.duplicate ? 'Такой PDF уже загружен' : 'PDF загружен, OCR поставлен в очередь');
      await load();
    } catch (error: unknown) { fail(error, 'Не получилось загрузить PDF'); }
    event.target.value = '';
    setBusy(null);
  }

  async function retrySource(sourceId: number): Promise<void> {
    setBusy(`retry-${String(sourceId)}`); setProblem(null);
    try {
      const result = await api.retryCourseSource(courseId, sourceId);
      setSourceStatus((all) => ({ ...all, [sourceId]: result.status }));
      setNotice('OCR поставлен на повтор');
    } catch (error: unknown) { fail(error, 'Не получилось повторить OCR'); }
    setBusy(null);
  }

  async function removeSource(sourceId: number): Promise<void> {
    if (!window.confirm('Удалить PDF из черновика?')) return;
    setBusy(`delete-${String(sourceId)}`); setProblem(null);
    try { await api.deleteCourseSource(courseId, sourceId); await load(); }
    catch (error: unknown) { fail(error, 'Не получилось удалить источник'); }
    setBusy(null);
  }

  async function build(): Promise<void> {
    if (draft === null) return;
    setBusy('build'); setProblem(null);
    try {
      await api.buildCourseDraft(courseId, {
        revisionId: draft.revision.id, editVersion: draft.revision.editVersion,
      });
      setBuildStatus('running'); setNotice('Сборка программы запущена');
    } catch (error: unknown) { fail(error, 'Не получилось запустить сборку'); }
    setBusy(null);
  }

  async function publish(): Promise<void> {
    if (draft === null || !window.confirm('Опубликовать эту редакцию для всех назначений курса?')) return;
    setBusy('publish'); setProblem(null);
    try {
      await api.publishCourse(courseId, {
        revisionId: draft.revision.id, editVersion: draft.revision.editVersion,
        idempotencyKey: `web-${courseId}-${String(draft.revision.id)}-${String(draft.revision.editVersion)}`,
      });
      setNotice('Редакция опубликована'); await load();
    } catch (error: unknown) { fail(error, 'Не получилось опубликовать курс'); }
    setBusy(null);
  }

  async function archive(): Promise<void> {
    if (!window.confirm('Архивировать курс? Новые назначения станут недоступны.')) return;
    setBusy('archive'); setProblem(null);
    try { await api.archiveCourse(courseId); setNotice('Курс архивирован'); await load(); }
    catch (error: unknown) { fail(error, 'Не получилось архивировать курс'); }
    setBusy(null);
  }

  async function createDraft(): Promise<void> {
    const active = card?.course.activeRevisionId;
    if (active === null || active === undefined) return;
    setBusy('draft'); setProblem(null);
    try { await api.createCourseDraft(courseId, active); await load(); }
    catch (error: unknown) { fail(error, 'Не получилось создать черновик'); }
    setBusy(null);
  }

  if (card === null) {
    return <main className="admin-shell"><header className="admin-header"><div><span>Каталог</span><strong>Курс</strong></div><button onClick={onBack}>К курсам</button></header>{problem === null ? <p role="status">Загружаю курс…</p> : <div className="admin-retry" role="alert"><p>{problem}</p><button onClick={() => setAttempt((value) => value + 1)}>Повторить</button></div>}</main>;
  }

  return (
    <main className="admin-shell admin-course-editor">
      <header className="admin-header">
        <div><span>{card.course.grade}</span><strong>{card.course.title}</strong></div>
        <button type="button" onClick={onBack}>К курсам</button>
        {card.course.status !== 'archived' && <button className="danger" disabled={busy !== null} type="button" onClick={() => { void archive(); }}>В архив</button>}
      </header>
      <div className="admin-course-state">
        <span className={`admin-status is-${card.course.status}`}>{card.course.status}</span>
        <code>{card.course.id}</code>
        {revisionLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
      {problem !== null && <div className="admin-retry" role="alert"><p>{problem}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Обновить данные</button></div>}
      {notice !== null && <p className="auth-message success" role="status">{notice}</p>}

      {draft === null ? (
        <section className="admin-panel"><h2>Опубликованная редакция неизменяема</h2><p>Создайте новый черновик на её основе.</p><button disabled={card.course.activeRevisionId === null || busy !== null} onClick={() => { void createDraft(); }}>Создать черновик</button></section>
      ) : (
        <>
          <section className="admin-panel">
            <div className="section-heading"><p>Черновик · версия {draft.revision.editVersion}</p><h2>Название и класс</h2></div>
            <form className="admin-course-form" onSubmit={(event) => { void saveMetadata(event); }}>
              <label><span>Название</span><input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label><span>Класс</span><input required maxLength={80} value={grade} onChange={(event) => setGrade(event.target.value)} /></label>
              <button disabled={busy !== null} type="submit">{busy === 'metadata' ? 'Сохраняю…' : 'Сохранить'}</button>
            </form>
          </section>

          <section className="admin-panel">
            <div className="section-heading"><p>PDF → OCR → программа</p><h2>Источники</h2></div>
            <label className="admin-upload"><span>{busy === 'upload' ? 'Загружаю PDF…' : 'Добавить PDF'}</span><input accept="application/pdf,.pdf" disabled={busy !== null} type="file" onChange={(event) => { void upload(event); }} /></label>
            {sources.length === 0 ? <p className="admin-empty">Источников нет — ручной курс можно публиковать без PDF</p> : sources.map((source) => (
              <article className={`admin-source is-${source.status}`} key={source.id}>
                <header><div><strong>{source.uploadName}</strong><span>{source.status} · {source.pageCount === null ? 'страницы считаются' : `${String(source.pageCount)} стр.`}</span></div><div><button disabled={busy !== null} onClick={() => { void retrySource(source.id); }}>Повторить OCR</button><button className="quiet" disabled={busy !== null} onClick={() => { void removeSource(source.id); }}>Удалить</button></div></header>
                {source.error !== null && <p role="alert">{source.error}</p>}
                <StatusPages status={sourceStatus[source.id]} />
              </article>
            ))}
            <div className="admin-build-row"><span>Сборка программы: <strong>{buildStatus}</strong></span><button disabled={busy !== null || !sourceReady || sources.length === 0} onClick={() => { void build(); }}>{busy === 'build' ? 'Запускаю…' : 'Собрать по источникам'}</button></div>
          </section>

          <section className="admin-panel">
            <div className="section-heading"><p>Порядок и зависимости</p><h2>Темы</h2></div>
            <div className="admin-topics">
              {topics.map((topic, index) => (
                <fieldset className="admin-topic" key={topic.key}>
                  <legend>Тема {String(index + 1)}</legend>
                  <label><span>Название</span><input required value={topic.title} onChange={(event) => changeTopic(topic.key, { title: event.target.value })} /></label>
                  <label><span>Основа промпта</span><textarea required value={topic.promptSeed} onChange={(event) => changeTopic(topic.key, { promptSeed: event.target.value })} /></label>
                  <div className="admin-topic-options">
                    <label><span>Вес</span><select value={topic.examWeight} onChange={(event) => changeTopic(topic.key, { examWeight: Number(event.target.value) })}><option value={0}>0</option><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
                    <label><span>Сложность</span><select value={topic.difficulty} onChange={(event) => changeTopic(topic.key, { difficulty: Number(event.target.value) })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
                    <label><span>Ответ</span><select value={topic.answerFormat} onChange={(event) => changeTopic(topic.key, { answerFormat: event.target.value as EditableTopic['answerFormat'] })}><option value="text">Текст</option><option value="number">Число</option><option value="choice">Выбор</option></select></label>
                  </div>
                  <label><span>Зависимости (ID через запятую)</span><input value={topic.prereqs.join(', ')} onChange={(event) => changeTopic(topic.key, { prereqs: event.target.value.split(',').map((part) => part.trim()).filter(Boolean) })} /></label>
                  <label className="admin-check"><input checked={topic.active} type="checkbox" onChange={(event) => changeTopic(topic.key, { active: event.target.checked })} /><span>Тема активна</span></label>
                  <button className="quiet" type="button" onClick={() => setTopics((items) => items.filter((item) => item.key !== topic.key))}>Удалить тему</button>
                </fieldset>
              ))}
            </div>
            <div className="admin-editor-actions"><button type="button" onClick={addTopic}>Добавить тему</button><button disabled={busy !== null || topics.some((topic) => topic.title.trim() === '' || topic.promptSeed.trim() === '')} type="button" onClick={() => { void saveTopics(); }}>{busy === 'topics' ? 'Сохраняю…' : 'Сохранить карту тем'}</button></div>
          </section>

          <section className="admin-panel admin-publish-panel">
            <div><h2>Публикация</h2><p>{publishBlocked ? 'Завершите OCR/сборку и устраните ошибки перед публикацией.' : 'Редакция готова стать активной для назначенных детей.'}</p></div>
            <button disabled={busy !== null || publishBlocked} onClick={() => { void publish(); }}>{busy === 'publish' ? 'Публикую…' : 'Опубликовать редакцию'}</button>
          </section>
        </>
      )}
    </main>
  );
}
