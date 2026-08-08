import { useEffect, useState } from 'react';
import { FinishScreen } from './FinishScreen';
import {
  browserHomeApi,
  type DayPlanResponse,
  type HomeApi,
  type ProfileSummary,
  type Subject,
} from './home-api';
import type { FinishRunResponse } from './run-api';

const SUBJECT_NAMES: Record<Subject, string> = {
  math: 'Математика',
  russian: 'Русский язык',
  english: 'Английский язык',
};

export interface HomeScreenProps {
  api?: HomeApi;
  now?: () => Date;
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

function daysUntil(examDate: string, now: Date): number {
  const exam = Date.parse(`${examDate}T00:00:00.000Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((exam - today) / 86_400_000);
}

function ExamCountdown({ examDate, now }: { examDate: string | null; now: Date }) {
  if (examDate === null) return <p>Добавь дату экзамена в профиле.</p>;
  const days = daysUntil(examDate, now);
  if (days < 0) return <p>Дата экзамена уже прошла.</p>;
  if (days === 0) return <p><strong>Экзамен сегодня.</strong> Ты готовился не зря.</p>;
  return <p>До экзамена <strong>{days}</strong> дн.</p>;
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
  const [finish, setFinish] = useState<FinishRunResponse | null>(null);

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

  async function start(subject: Subject, kind: 'run' | 'triage'): Promise<void> {
    setStarting(subject);
    setProblem(null);
    try {
      const started = kind === 'triage'
        ? await api.startTriage(subject)
        : await api.start(subject);
      if (started.progress.done) {
        setFinish(await api.finish(started.runId));
        return;
      }
      navigate(`/?runId=${started.runId}${kind === 'triage' ? '&kind=triage' : ''}`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось начать занятие');
    } finally {
      setStarting(null);
    }
  }

  if (finish !== null) return <FinishScreen result={finish} />;

  const anyTriagePassed = plan?.triage.some((item) => item.passed) ?? false;
  const nextTriage = plan?.triage.find((item) => !item.passed)?.subject ?? 'math';

  return (
    <main className="home-shell">
      <header className="home-header">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div><span>Подготовка к экзамену</span><strong>Эдукатор</strong></div>
        <a className="profile-link" href="/?screen=profile">Профиль</a>
      </header>

      <section className="home-intro">
        <div>
          <p className="home-kicker">План на сегодня</p>
          <h1>{anyTriagePassed ? 'Выбирай первый забег' : 'Сначала сверим карту знаний'}</h1>
          <p>{anyTriagePassed
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
      ) : plan === null ? null : !anyTriagePassed ? (
        <section className="triage-offer" aria-labelledby="triage-title">
          <span aria-hidden="true">01</span>
          <div>
            <p>Первый шаг · {SUBJECT_NAMES[nextTriage]}</p>
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
          <section className="forecast-strip" aria-labelledby="forecast-title">
            <div className="section-heading">
              <p>Текущая форма</p>
              <h2 id="forecast-title">Прогноз по предметам</h2>
            </div>
            <div className="forecast-cards">
              {(Object.keys(SUBJECT_NAMES) as Subject[]).map((subject) => {
                const forecast = plan.forecasts.find((item) => item.subject === subject);
                return (
                  <article key={subject}>
                    <span>{SUBJECT_NAMES[subject]}</span>
                    <strong>{forecast === undefined ? '—' : forecast.score.toFixed(1)}</strong>
                    <small>{forecast === undefined
                      ? 'Пока нет прогноза'
                      : `диапазон ${forecast.low.toFixed(1)}–${forecast.high.toFixed(1)}`}</small>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="day-plan" aria-labelledby="day-plan-title">
            <div className="section-heading day-plan-heading">
              <div><p>2–3 подхода</p><h2 id="day-plan-title">Забеги на сегодня</h2></div>
              {plan.triage.some((item) => !item.passed) && (
                <button
                  className="secondary compact-triage"
                  type="button"
                  disabled={starting !== null}
                  onClick={() => void start(nextTriage, 'triage')}
                >
                  {starting === nextTriage ? 'Начинаю…' : `Пройти триаж · ${SUBJECT_NAMES[nextTriage]}`}
                </button>
              )}
            </div>
            {plan.plan.length === 0 ? (
              <div className="empty-day"><strong>На сегодня всё закрыто</strong><span>Можно отдыхать без чувства долга.</span></div>
            ) : (
              <div className="plan-cards">
                {plan.plan.map((item, index) => (
                  <article key={`${item.subject}:${item.topic.id}`}>
                    <span className="plan-number">{String(index + 1).padStart(2, '0')}</span>
                    <div><small>{SUBJECT_NAMES[item.subject]}</small><h3>{item.topic.title}</h3></div>
                    <button
                      className="primary"
                      type="button"
                      disabled={starting !== null}
                      onClick={() => void start(item.subject, 'run')}
                    >
                      {starting === item.subject ? 'Начинаю…' : 'Начать'}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
