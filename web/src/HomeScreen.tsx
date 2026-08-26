import { useEffect, useState, type CSSProperties } from 'react';
import { FinishScreen } from './FinishScreen';
import {
  browserHomeApi,
  type DayPlanResponse,
  type HomeTopic,
  type HomeApi,
  type PlannedRun,
  type ProfileSummary,
  type Subject,
} from './home-api';
import type { FinishRunResponse } from './run-api';
import { isPreliminaryForecast } from './forecast-presentation';
import { BrandLink } from './BrandMark';
import { courseById, courseColor, courseInitials, type CourseMeta } from './course-meta';

export interface HomeScreenProps {
  api?: HomeApi;
  now?: () => Date;
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});
const moscowRunDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long',
});

function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year as number, (month as number) - 1, day) / 86_400_000);
}

function daysUntil(examDate: string, now: Date): number {
  return dayNumber(examDate) - dayNumber(moscowDateFormatter.format(now));
}

function runStartedText(startedAt: string, currentDay: string): string {
  const started = new Date(startedAt);
  const daysAgo = dayNumber(currentDay) - dayNumber(moscowDateFormatter.format(started));
  if (daysAgo === 0) return 'начат сегодня';
  if (daysAgo === 1) return 'начат вчера';
  return `начат ${moscowRunDateFormatter.format(started)}`;
}

function runMeta(item: PlannedRun, currentDay: string, course: CourseMeta): string {
  if (item.active === undefined) return course.title;
  return `${course.title} · ${item.active.progress.total} из ` +
    `${item.active.progress.target} · ${runStartedText(item.active.startedAt, currentDay)}`;
}

function ExamCountdown({ examDate, now }: { examDate: string | null; now: Date }) {
  if (examDate === null) return <p>Добавь дату экзамена в профиле.</p>;
  const days = daysUntil(examDate, now);
  if (days < 0) return <p>Дата экзамена уже прошла.</p>;
  if (days === 0) return <p><strong>Экзамен сегодня.</strong> Ты готовился не зря.</p>;
  return <p>До экзамена <strong>{days}</strong> дн.</p>;
}

function StreakCard({ streak }: { streak: DayPlanResponse['streak'] }) {
  let title: string;
  let note: string;
  if (streak.best === 0) {
    title = 'Первый день серии впереди';
    note = 'Один обычный забег положит начало.';
  } else if (streak.current === 0) {
    title = 'Начни новую серию';
    note = `Лучший результат — ${streak.best} дн.`;
  } else {
    title = `${streak.current} дн. подряд`;
    note = streak.completedToday
      ? 'Сегодня серия уже продолжена.'
      : 'Сегодняшний забег продолжит серию.';
  }
  return (
    <section className="streak-card" aria-label="Серия занятий">
      <span>Серия занятий</span>
      <strong>{title}</strong>
      <small>{note}</small>
    </section>
  );
}

function remainingRunsText(remaining: number): string {
  if (remaining === 1) return 'Остался 1 обычный забег до разблокировки.';
  if (remaining >= 2 && remaining <= 4) {
    return `Осталось ${remaining} обычных забега до разблокировки.`;
  }
  return `Осталось ${remaining} обычных забегов до разблокировки.`;
}

function AccessCard({ gate }: { gate: DayPlanResponse['gate'] }) {
  const progress = gate.required === 0
    ? 100
    : Math.min(100, Math.round((gate.completed / gate.required) * 100));
  const title = gate.unlocked ? 'Компьютер разблокирован' : 'Компьютер заблокирован';
  let note: string;
  if (gate.override?.mode === 'unlocked') {
    note = 'Доступ временно открыт родителем. Учебный план продолжается.';
  } else if (gate.override?.mode === 'blocked') {
    note = 'Доступ временно закрыт родителем до следующего дня.';
  } else if (gate.unlocked) {
    note = 'План выполнен. Доступ открыт до следующего дня.';
  } else if (gate.remaining === 0 && gate.learning.required && !gate.learning.passed) {
    note = 'Обычные забеги завершены. Для доступа нужен зачёт за разбор темы.';
  } else if (gate.learning.required && !gate.learning.passed) {
    note = 'Для доступа заверши обычные забеги и получи зачёт за разбор темы.';
  } else {
    note = remainingRunsText(gate.remaining);
  }
  const learningStatus = gate.learning.required
    ? gate.learning.passed ? 'зачтён' : 'нужен зачёт'
    : 'не требуется';

  return (
    <section
      className={`access-card ${gate.unlocked ? 'access-card-open' : 'access-card-locked'}`}
      aria-labelledby="access-card-title"
    >
      <div className="access-card-copy">
        <p>{gate.unlocked ? 'Доступ открыт' : 'Доступ закрыт'}</p>
        <h2 id="access-card-title">{title}</h2>
        <span>{note}</span>
      </div>
      <div className="access-card-progress">
        <div className="access-condition">
          <span>Обычные забеги:{' '}</span><strong>{gate.completed}/{gate.required}</strong>
        </div>
        <div
          className="access-progress-track"
          role="progressbar"
          aria-label="Прогресс разблокировки компьютера"
          aria-valuemin={0}
          aria-valuemax={gate.required}
          aria-valuenow={gate.completed}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="access-condition">
          <span>Разбор темы:{' '}</span><strong>{learningStatus}</strong>
        </div>
      </div>
    </section>
  );
}

function topicStatus(topic: HomeTopic): string {
  switch (topic.readiness.status) {
    case 'preparing': return 'Босс готовится';
    case 'ready': return topic.readiness.eligible ? 'Можно вызвать босса' : 'В работе';
    case 'active': return 'Бой уже начат';
    case 'closed': return 'Закрыта';
    case 'working': return topic.readiness.eligible ? 'Босс готовится' : 'В работе';
  }
}

function showsBossProgress(topic: HomeTopic): boolean {
  return !topic.readiness.eligible &&
    (topic.readiness.status === 'working' || topic.readiness.status === 'ready');
}

function TopicBossProgress({ topic }: { topic: HomeTopic }) {
  return (
    <div className="topic-progress">
      <div className="topic-progress-label">
        <small>{topic.bossProgress}%</small>
      </div>
      <div
        className="topic-progress-track"
        role="progressbar"
        aria-label={`Прогресс темы «${topic.title}» до босса`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={topic.bossProgress}
      >
        <span style={{ width: `${topic.bossProgress}%` }} />
      </div>
    </div>
  );
}

export function HomeScreen({
  api = browserHomeApi,
  now = () => new Date(),
  navigate = defaultNavigate,
}: HomeScreenProps) {
  const [plan, setPlan] = useState<DayPlanResponse | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState<Subject | null>(null);
  const [startingBoss, setStartingBoss] = useState<string | null>(null);
  const [finishingRunId, setFinishingRunId] = useState<number | null>(null);
  const [finish, setFinish] = useState<{
    result: FinishRunResponse;
    kind: 'run' | 'triage';
  } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.plan(), api.profile()])
      .then(([nextPlan, nextProfile]) => {
        if (!active) return;
        setPlan(nextPlan);
        setProfile(nextProfile);
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить план дня');
      });
    return () => { active = false; };
  }, [api]);

  async function start(subject: Subject, kind: 'run' | 'triage', topicId?: string): Promise<void> {
    setStarting(subject);
    setProblem(null);
    try {
      let started;
      if (kind === 'triage') {
        started = await api.startTriage(subject);
      } else {
        if (topicId === undefined) throw new Error('Не выбрана тема занятия');
        started = await api.start(subject, topicId);
      }
      const target = `/?runId=${started.runId}${kind === 'triage' ? '&kind=triage' : ''}`;
      if (started.progress.done) {
        const summary = await api.finish(started.runId);
        if ('status' in summary) navigate(target);
        else setFinish({ result: summary, kind });
        return;
      }
      navigate(target);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось начать занятие');
    } finally {
      setStarting(null);
    }
  }

  async function startBoss(topicId: string): Promise<void> {
    setStartingBoss(topicId);
    setProblem(null);
    try {
      const started = await api.startBoss(topicId);
      navigate(`/?runId=${started.runId}&kind=boss`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось начать бой с боссом');
    } finally {
      setStartingBoss(null);
    }
  }

  async function continueRun(active: NonNullable<PlannedRun['active']>): Promise<void> {
    if (!active.progress.done) {
      navigate(`/?runId=${active.runId}`);
      return;
    }
    setFinishingRunId(active.runId);
    setProblem(null);
    try {
      const summary = await api.finish(active.runId);
      // Отвеченный забег закрывается не здесь: маршрут сперва запускает проверку
      // осмысленности и отвечает `checking` или `retry_required`. Экран повтора и
      // ожидание проверки живут в `RunScreen`, и он сам входит в них при заходе
      // на уже отвеченный забег (`next` отвечает `run-complete`, дальше тот же
      // `finish`). Поэтому здесь — переход, а не вторая копия этих экранов.
      if ('status' in summary) navigate(`/?runId=${active.runId}`);
      else setFinish({ result: summary, kind: 'run' });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось завершить забег');
    } finally {
      setFinishingRunId(null);
    }
  }

  if (finish !== null) return <FinishScreen result={finish.result} kind={finish.kind} />;

  const courses = plan?.courses ?? [];
  const anySubjectCalibrated = plan?.triage.some((item) => !item.needed) ?? false;
  const nextTriage = plan?.triage.find((item) => item.needed)?.subject;
  const closedTopicIds = new Set(
    plan?.topics.filter((topic) => topic.readiness.status === 'closed').map((topic) => topic.id) ?? [],
  );
  const visiblePlan = plan?.plan.filter((item) => !closedTopicIds.has(item.topic.id)) ?? [];
  const visibleLearning = plan === null ? [] : [...plan.learning].sort((left, right) => {
    const requiredId = plan.gate.learning.required ? plan.gate.learning.materialId : null;
    if (left.id === requiredId) return -1;
    if (right.id === requiredId) return 1;
    return 0;
  });

  return (
    <main className="home-shell">
      <header className="home-header">
        <BrandLink />
        <div><span>Подготовка к экзамену</span><strong>Эдукатор</strong></div>
        <a className="profile-link" href="/?screen=profile">Профиль</a>
      </header>

      {plan !== null && <AccessCard gate={plan.gate} />}
      {plan !== null && <StreakCard streak={plan.streak} />}

      <section className="home-intro">
        <div>
          <p className="home-kicker">План на сегодня</p>
          <h1>{courses.length === 0
            ? 'Курсы пока не назначены'
            : anySubjectCalibrated ? 'Выбирай первый забег' : 'Сначала сверим карту знаний'}</h1>
          <p>{courses.length === 0
            ? 'Попроси родителя выбрать курсы в семейном кабинете.'
            : anySubjectCalibrated
            ? 'Короткие забеги держат темп и показывают, что уже стало увереннее.'
            : 'Триаж расставит темы по приоритету — после него появится план дня.'}</p>
        </div>
        <aside className="exam-countdown" aria-label="Обратный отсчёт до экзамена">
          <span>Точка назначения</span>
          {profile === null ? <p>Считаю дни…</p> : <ExamCountdown examDate={profile.examDate} now={now()} />}
        </aside>
      </section>

      {problem !== null && <p className="home-error" role="alert">{problem}</p>}

      {plan === null && problem === null ? (
        <section className="home-loading" aria-label="Загрузка плана">Собираю план дня…</section>
      ) : plan === null ? null : courses.length === 0 ? (
        <section className="home-empty-courses" aria-labelledby="empty-courses-title">
          <span aria-hidden="true">○</span>
          <div><h2 id="empty-courses-title">Здесь появится учебный план</h2>
            <p>Когда родитель назначит хотя бы один курс, можно будет пройти триаж и начать занятия.</p></div>
        </section>
      ) : !anySubjectCalibrated && nextTriage !== undefined ? (
        <section className="triage-offer" aria-labelledby="triage-title">
          <span aria-hidden="true">01</span>
          <div>
            <p>Первый шаг · {courseById(courses, nextTriage).title}</p>
            <h2 id="triage-title">Быстрый триаж</h2>
            <small>12 коротких вопросов без подсказок</small>
          </div>
          <button
            className="primary"
            type="button"
            disabled={starting !== null}
            onClick={() => void start(nextTriage, 'triage')}
          >
            {starting === nextTriage ? 'Начинаю…' : 'Пройти триаж'}
          </button>
        </section>
      ) : (
        <>
          {visibleLearning.length > 0 && (
            <section className="learning-offer" aria-labelledby="learning-offer-title">
              <div className="section-heading">
                <p>Персональный разбор</p>
                <h2 id="learning-offer-title">Разобрать слабое место</h2>
              </div>
              <div className="learning-cards">
                {visibleLearning.map((material) => {
                  const required = plan.gate.learning.required &&
                    plan.gate.learning.materialId === material.id;
                  return (
                    <article
                      className={`learning-card${required ? ' learning-card-required' : ''}`}
                      key={material.id}
                      style={{ '--subject-accent': courseColor(material.subject) } as CSSProperties}
                    >
                      <span className="learning-card-mark" aria-hidden="true">
                        {courseInitials(courseById(courses, material.subject).title)}
                      </span>
                      <div className="learning-card-copy">
                        {required && <span className="learning-required-badge">Обязательный разбор</span>}
                        <small>{courseById(courses, material.subject).title} · {material.estimatedMinutes} минут</small>
                        <h3>{material.topic.title}</h3>
                        <p>{material.recommendationReason}</p>
                      </div>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => navigate(`/?learningId=${material.id}`)}
                      >
                        {material.status === 'active' ? 'Продолжить разбор' : 'Разобрать тему'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <section className="forecast-strip" aria-labelledby="forecast-title">
            <div className="section-heading">
              <p>Текущая форма</p>
              <h2 id="forecast-title">Прогноз по предметам</h2>
            </div>
            <div className="forecast-cards">
              {courses.map((course) => {
                const forecast = plan.forecasts.find((item) => item.subject === course.courseId);
                const preliminary = forecast !== undefined && isPreliminaryForecast(forecast);
                return (
                  <article key={course.courseId} style={{ borderColor: courseColor(course.courseId) }}>
                    <span>{course.title}{course.grade === '' ? '' : ` · ${course.grade}`}</span>
                    <strong className={preliminary ? 'forecast-pending' : undefined}>{forecast === undefined
                      ? '—'
                      : preliminary ? 'Собираем данные' : forecast.score.toFixed(1)}</strong>
                    <small>{forecast === undefined
                      ? 'Пока нет прогноза'
                      : preliminary
                        ? 'Оценка появится после ещё нескольких тем'
                        : `диапазон ${forecast.low.toFixed(1)}–${forecast.high.toFixed(1)}`}</small>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="day-plan" aria-labelledby="day-plan-title">
            <div className="section-heading day-plan-heading">
              <div>
                <p>{plan.gate.completed} из {plan.gate.required} завершено</p>
                <h2 id="day-plan-title">Забеги на сегодня</h2>
              </div>
              {nextTriage !== undefined && (
                <button
                  className="secondary compact-triage"
                  type="button"
                  disabled={starting !== null}
                  onClick={() => void start(nextTriage, 'triage')}
                >
                  {starting === nextTriage ? 'Начинаю…' : `Пройти триаж · ${courseById(courses, nextTriage).title}`}
                </button>
              )}
            </div>
            {visiblePlan.length === 0 ? (
              <div className="empty-day"><strong>На сегодня всё закрыто</strong><span>Можно отдыхать без чувства долга.</span></div>
            ) : (
              <div className="plan-cards">
                {visiblePlan.map((item, index) => {
                  const active = item.active;
                  return (
                    <article key={active === undefined
                      ? `${item.subject}:${item.topic.id}`
                      : `run:${active.runId}`}>
                      <span className="plan-number">{String(index + 1).padStart(2, '0')}</span>
                      <div><small>{runMeta(item, plan.gate.day, courseById(courses, item.subject))}</small><h3>{item.topic.title}</h3></div>
                      <button
                        className="primary"
                        type="button"
                        disabled={starting !== null || finishingRunId !== null}
                        onClick={() => void (active === undefined
                          ? start(item.subject, 'run', item.topic.id)
                          : continueRun(active))}
                      >
                        {active !== undefined && finishingRunId === active.runId
                          ? 'Завершаю…'
                          : active?.progress.done === true
                            ? 'Завершить'
                            : active !== undefined
                              ? 'Продолжить'
                              : starting === item.subject
                                ? 'Начинаю…'
                                : 'Начать'}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {plan !== null && (
        <section className="topic-map" aria-labelledby="topic-map-title">
          <div className="section-heading">
            <p>Путь к боссам</p>
            <h2 id="topic-map-title">Карта тем</h2>
          </div>
          <div className="topic-map-subjects">
            {courses.map((course) => (
              <section key={course.courseId} aria-labelledby={`topic-map-${course.courseId}`}>
                <h3 id={`topic-map-${course.courseId}`}>{course.title} <small aria-hidden="true">{course.grade}</small></h3>
                <ul>
                  {plan.topics.filter((topic) => topic.subject === course.courseId).map((topic) => {
                    const canStart = topic.readiness.status === 'active' ||
                      (topic.readiness.status === 'ready' && topic.readiness.eligible);
                    return (
                      <li
                        className={topic.readiness.status === 'closed' ? 'topic-closed' : undefined}
                        key={topic.id}
                      >
                        <div className="topic-details">
                          <span className="topic-title">{topic.title}</span>
                          {showsBossProgress(topic)
                            ? <TopicBossProgress topic={topic} />
                            : <small className="topic-state">{topicStatus(topic)}</small>}
                        </div>
                        {canStart && (
                          <button
                            className="secondary topic-boss-button"
                            type="button"
                            disabled={startingBoss !== null}
                            onClick={() => void startBoss(topic.id)}
                          >
                            {startingBoss === topic.id
                              ? 'Начинаю…'
                              : topic.readiness.status === 'active' ? 'Продолжить бой' : 'Вызвать босса'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
