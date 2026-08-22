import { useEffect, useState, type FormEvent } from 'react';
import { browserAdminApi, type AdminApi, type AdminCourse } from '../admin-api';
import { HttpError } from '../http';
import type { AdminSignOutReason } from './AdminHomeScreen';

const STATUS_LABELS: Record<AdminCourse['status'], string> = {
  draft: 'Черновик', published: 'Опубликован', archived: 'В архиве',
};

export function AdminCoursesScreen({
  api = browserAdminApi,
  onBack,
  onCourse,
  onSignedOut,
}: {
  api?: AdminApi;
  onBack: () => void;
  onCourse: (courseId: string) => void;
  onSignedOut: (reason: AdminSignOutReason) => void;
}) {
  const [courses, setCourses] = useState<AdminCourse[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState('');
  const [grade, setGrade] = useState('');
  const [courseId, setCourseId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    setCourses(null);
    setProblem(null);
    void api.courses().then(({ courses: loaded }) => {
      if (live) setCourses(loaded);
    }).catch((error: unknown) => {
      if (!live) return;
      if (error instanceof HttpError && error.status === 401) onSignedOut('expired');
      else setProblem(error instanceof Error ? error.message : 'Не получилось загрузить курсы');
    });
    return () => { live = false; };
  }, [api, attempt, onSignedOut]);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setProblem(null);
    try {
      const created = await api.createCourse({
        ...(courseId.trim() === '' ? {} : { id: courseId.trim() }),
        title: title.trim(),
        grade: grade.trim(),
      });
      onCourse(created.course.id);
    } catch (error: unknown) {
      if (error instanceof HttpError && error.status === 401) onSignedOut('expired');
      else setProblem(error instanceof Error ? error.message : 'Не получилось создать курс');
      setCreating(false);
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div><span>Управление обучением</span><strong>Курсы</strong></div>
        <button type="button" onClick={onBack}>К сводке</button>
      </header>

      <section className="admin-panel admin-course-create">
        <div className="section-heading"><p>Новый учебный маршрут</p><h2>Создать курс</h2></div>
        <form className="admin-course-form" onSubmit={(event) => { void create(event); }}>
          <label><span>Название</span><input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>Класс</span><input required maxLength={80} value={grade} onChange={(event) => setGrade(event.target.value)} /></label>
          <label><span>ID (необязательно)</span><input maxLength={80} value={courseId} onChange={(event) => setCourseId(event.target.value)} placeholder="geography-5" /></label>
          <button disabled={creating || title.trim() === '' || grade.trim() === ''} type="submit">
            {creating ? 'Создаю…' : 'Создать курс'}
          </button>
        </form>
      </section>

      {problem !== null && (
        <div className="admin-retry" role="alert">
          <p>{problem}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Повторить</button>
        </div>
      )}
      {courses === null && problem === null && <p role="status">Загружаю каталог…</p>}
      {courses !== null && (
        <section className="admin-panel">
          <div className="section-heading"><p>Все классы и направления</p><h2>Каталог</h2></div>
          {courses.length === 0 ? <p className="admin-empty">Курсов пока нет</p> : (
            <ul className="admin-course-list">
              {courses.map((course) => (
                <li key={course.id} className={`admin-course-card is-${course.status}`}>
                  <div>
                    <span className="admin-status">{STATUS_LABELS[course.status]}</span>
                    <h3>{course.title}</h3>
                    <p>{course.grade} · <code>{course.id}</code></p>
                  </div>
                  <button type="button" onClick={() => onCourse(course.id)}>Открыть</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
