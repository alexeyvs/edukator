import { useEffect, useState } from 'react';
import { browserParentsApi, type ParentsApi, type ParentsDashboard } from './parents-api';
import { SUBJECT_NAMES, SUBJECTS } from './subject-meta';

const KIND_NAMES = {
  run: 'Обычный забег',
  triage: 'Триаж',
  boss: 'Босс',
  lesson: 'Тест по разбору',
} as const;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});
const shortDayFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
});
const activityDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function previousDay(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, (date as number) - count))
    .toISOString().slice(0, 10);
}

function windowDays(dashboard: ParentsDashboard): Array<{ date: string; minutes: number }> {
  const last = dayFormatter.format(new Date(dashboard.window.until));
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: previousDay(last, 6 - index),
    minutes: 0,
  }));
  const position = new Map(days.map((day, index) => [day.date, index]));
  for (const item of dashboard.time.daily) {
    // Скользящее окно в 168 часов захватывает восемь дат: неполный первый день
    // складываем с самой старой из семи колонок графика.
    const index = position.get(item.date) ?? 0;
    const day = days[index];
    if (day !== undefined) day.minutes += item.minutes;
  }
  return days;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function Flags({ dashboard }: { dashboard: ParentsDashboard }) {
  const observations = [
    ...(dashboard.flags.threeFullDaysWithoutRun ? ['Три полных дня без обычных забегов.'] : []),
    ...dashboard.flags.forecastNotGrowing.map((subject) =>
      `Прогноз по предмету «${SUBJECT_NAMES[subject]}» не растёт пять дней.`),
    ...dashboard.flags.reduceLoad.map((subject) =>
      `${SUBJECT_NAMES[subject]}: нижняя граница прогноза уже не ниже 4,0 — нагрузку можно обсудить.`),
  ];
  return (
    <section className="parents-panel parents-flags" aria-labelledby="parents-flags-title">
      <div className="section-heading">
        <p>Наблюдения, не указания</p>
        <h2 id="parents-flags-title">На что обратить внимание</h2>
      </div>
      {observations.length === 0
        ? <p className="parents-empty">За неделю нет наблюдений, требующих внимания.</p>
        : <ul>{observations.map((item) => <li key={item}>{item}</li>)}</ul>}
    </section>
  );
}

export function ParentsScreen({ api = browserParentsApi }: { api?: ParentsApi }) {
  const [dashboard, setDashboard] = useState<ParentsDashboard | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.read()
      .then((loaded) => { if (active) setDashboard(loaded); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить сводку');
      });
    return () => { active = false; };
  }, [api]);

  if (problem !== null) {
    return <main className="parents-state"><p role="alert">{problem}</p></main>;
  }
  if (dashboard === null) {
    return <main className="parents-state" role="status"><p>Собираю сводку за неделю…</p></main>;
  }

  const days = windowDays(dashboard);
  const maxMinutes = Math.max(1, ...days.map((item) => item.minutes));

  return (
    <main className="parents-shell">
      <header className="parents-header">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <div><span>Открытая сводка</span><strong>Для ученика и родителей</strong></div>
        <a className="parents-home" href="/">К плану дня</a>
      </header>

      <section className="parents-intro">
        <p className="home-kicker">Последние семь дней</p>
        <h1>Картина подготовки без приукрашивания</h1>
        <p>Те же данные видит ученик. Здесь нет настроек и способов управлять его учебным планом.</p>
      </section>

      <section className="parents-panel" aria-labelledby="parents-forecast-title">
        <div className="section-heading"><p>Прогноз, не оценка</p><h2 id="parents-forecast-title">По предметам</h2></div>
        <div className="parents-forecasts">
          {SUBJECTS.map((subject) => {
            const forecast = dashboard.forecasts.find((item) => item.subject === subject);
            return (
              <article key={subject} aria-label={`Прогноз: ${SUBJECT_NAMES[subject]}`}>
                <span>{SUBJECT_NAMES[subject]}</span>
                {forecast === undefined ? <p>Прогноз пока недоступен</p> : <>
                  <strong>{forecast.score.toFixed(1)} <small>± {forecast.band.toFixed(1)}</small></strong>
                  <p>Диапазон {forecast.low.toFixed(1)}–{forecast.high.toFixed(1)}</p>
                  <p>За 7 дней: {forecast.delta === undefined ? 'нет точки сравнения' : signed(forecast.delta)}</p>
                  {forecast.preliminary && <em>Предварительный прогноз: данных пока мало</em>}
                </>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="parents-panel parents-time" aria-labelledby="parents-time-title">
        <div className="section-heading"><p>Честное время</p><h2 id="parents-time-title">План и факт</h2></div>
        <div className="parents-time-total">
          <div><span>План</span><strong>{dashboard.time.plannedMinutes} мин</strong></div>
          <div><span>Факт</span><strong>{dashboard.time.actualMinutes} мин</strong></div>
        </div>
        <div className="parents-bars" aria-label="Активное время по дням">
          {days.map((day) => (
            <div key={day.date}>
              <span className="parents-bar-value">{day.minutes}</span>
              <span className="parents-bar-track"><span style={{ height: `${String((day.minutes / maxMinutes) * 100)}%` }} /></span>
              <time dateTime={day.date}>{shortDayFormatter.format(new Date(`${day.date}T12:00:00.000Z`))}</time>
            </div>
          ))}
        </div>
      </section>

      <div className="parents-columns">
        <section className="parents-panel" aria-labelledby="parents-gaps-title">
          <div className="section-heading"><p>До пяти тем</p><h2 id="parents-gaps-title">Что пока даётся труднее</h2></div>
          {dashboard.gaps.length === 0
            ? <p className="parents-empty">Проблемные темы пока не определились.</p>
            : <ol className="parents-gaps">{dashboard.gaps.slice(0, 5).map((gap) => (
              <li key={`${gap.subject}:${gap.title}`}><span>{gap.title}</span><small>{SUBJECT_NAMES[gap.subject]}</small></li>
            ))}</ol>}
        </section>

        <section className="parents-panel" aria-labelledby="parents-activity-title">
          <div className="section-heading"><p>История занятий</p><h2 id="parents-activity-title">Лента забегов</h2></div>
          {dashboard.activity.length === 0
            ? <p className="parents-empty">За эту неделю завершённых забегов пока нет.</p>
            : <ol className="parents-activity">{dashboard.activity.map((item, index) => (
              <li className={`activity-${item.kind}`} key={`${item.finishedAt}:${String(index)}`}>
                <div><strong>{KIND_NAMES[item.kind]}</strong><small>{SUBJECT_NAMES[item.subject]}</small></div>
                <p>{item.correct} из {item.total} · {item.activeMinutes} мин
                  {item.kind === 'boss' && ` · ${item.bossOutcome === 'won' ? 'победа' : 'попытка'}`}</p>
                <time dateTime={item.finishedAt}>{activityDateFormatter.format(new Date(item.finishedAt))}</time>
              </li>
            ))}</ol>}
        </section>
      </div>

      <Flags dashboard={dashboard} />
    </main>
  );
}
