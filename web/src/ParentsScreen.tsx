import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DailyGateState } from './home-api';
import {
  browserParentsApi,
  ComputerAccessError,
  type ComputerAccessMode,
  type ParentsApi,
  type ParentsDashboard,
} from './parents-api';
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
const accessExpiryFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

const ACCESS_MODES: Array<{ mode: ComputerAccessMode; label: string }> = [
  { mode: 'automatic', label: 'По плану' },
  { mode: 'blocked', label: 'Заблокировать' },
  { mode: 'unlocked', label: 'Разблокировать' },
];

const CONFIRMATIONS: Record<ComputerAccessMode, { title: string; text: string; action: string }> = {
  automatic: {
    title: 'Вернуть режим «По плану»?',
    text: 'Доступ снова будет зависеть от дневного плана.',
    action: 'Вернуть режим «По плану»',
  },
  blocked: {
    title: 'Временно заблокировать компьютер?',
    text: 'Команда действует до следующей московской полуночи.',
    action: 'Заблокировать',
  },
  unlocked: {
    title: 'Временно разблокировать компьютер?',
    text: 'Учебный план при этом не меняется.',
    action: 'Разблокировать',
  },
};

function accessMode(access: DailyGateState): ComputerAccessMode {
  return access.override?.mode ?? 'automatic';
}

function accessStatus(access: DailyGateState): { eyebrow: string; title: string; note: string } {
  if (access.override?.mode === 'blocked') {
    return {
      eyebrow: 'Временный режим',
      title: 'Компьютер заблокирован',
      note: `До ${accessExpiryFormatter.format(new Date(access.override.expiresAt))}`,
    };
  }
  if (access.override?.mode === 'unlocked') {
    return {
      eyebrow: 'Временный режим',
      title: 'Компьютер разблокирован',
      note: `До ${accessExpiryFormatter.format(new Date(access.override.expiresAt))}`,
    };
  }
  return {
    eyebrow: 'Режим по плану',
    title: access.automaticUnlocked ? 'Компьютер разблокирован' : 'Компьютер заблокирован',
    note: access.automaticUnlocked
      ? 'Условия дневного плана выполнены.'
      : 'Доступ откроется после выполнения условий дневного плана.',
  };
}

function ComputerAccessPanel({
  access,
  api,
  onChanged,
  onExpired,
}: {
  access: ParentsDashboard['computerAccess'];
  api: ParentsApi;
  onChanged: (next: DailyGateState) => void;
  onExpired: () => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [selected, setSelected] = useState<ComputerAccessMode | null>(null);
  const [pending, setPending] = useState(false);
  const [expiryPending, setExpiryPending] = useState(false);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [accessClock, setAccessClock] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const refreshedExpiry = useRef<string | null>(null);
  const refreshGeneration = useRef(0);
  const expiresAt = access.override === null ? Number.NaN : Date.parse(access.override.expiresAt);
  const overrideActive = Number.isFinite(expiresAt) && expiresAt > accessClock;
  const overrideExpired = access.override !== null && !overrideActive;
  const current = overrideExpired ? null : accessMode(access);
  const status = overrideExpired
    ? {
      eyebrow: expiryPending ? 'Обновляю состояние' : 'Состояние не подтверждено',
      title: expiryPending ? 'Проверяю доступ к компьютеру' : 'Состояние доступа неизвестно',
      note: expiryPending
        ? 'Получаю актуальный режим нового дня.'
        : 'Не получилось получить актуальный режим. Старое состояние не используется.',
    }
    : accessStatus(access);
  const pinValid = /^\d{6,12}$/u.test(pin);

  useEffect(() => {
    if (access.override === null) {
      refreshedExpiry.current = null;
      return;
    }
    const expiryKey = access.override.expiresAt;
    const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 0;
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setAccessClock(now);
        if (Number.isFinite(expiresAt) && now < expiresAt) return;
        if (refreshedExpiry.current === expiryKey) return;
        refreshedExpiry.current = expiryKey;
        const generation = ++refreshGeneration.current;
        setSelected(null);
        setExpiryPending(true);
        setExpiryError(null);
        void onExpired()
          .catch((error: unknown) => {
            if (refreshGeneration.current !== generation) return;
            setExpiryError(error instanceof Error
              ? error.message
              : 'Не получилось обновить состояние доступа');
          })
          .finally(() => {
            if (refreshGeneration.current === generation) setExpiryPending(false);
          });
      },
      Math.min(2_147_483_647, Math.max(0, remaining)),
    );
    return () => window.clearTimeout(timer);
  }, [access.override, accessClock, expiresAt, onExpired]);

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selected === null || !pinValid || pending || expiryPending) return;
    setPending(true);
    setFeedback(null);
    try {
      const next = await api.changeComputerAccess(selected, pin);
      onChanged(next);
      setExpiryError(null);
      setSelected(null);
      setFeedback({ kind: 'success', text: 'Режим доступа обновлён.' });
    } catch (error: unknown) {
      if (error instanceof ComputerAccessError && error.status === 401) setPin('');
      setSelected(null);
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не получилось изменить режим доступа',
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className={`parents-access${overrideActive ? ' parents-access-temporary' : ''}`}
      aria-labelledby="parents-access-title"
    >
      <div className="parents-access-summary">
        <p>{status.eyebrow}</p>
        <h2 id="parents-access-title">{status.title}</h2>
        <span>{status.note}</span>
        {access.configured
          ? <label className="parents-pin">
            <span>PIN родителя</span>
            <input
              aria-describedby="parents-pin-note"
              autoComplete="off"
              inputMode="numeric"
              maxLength={12}
              pattern="[0-9]{6,12}"
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
            <small id="parents-pin-note">Остаётся только в этой вкладке.</small>
          </label>
          : <p className="parents-access-unavailable">PIN родителя не настроен. Управление доступом отключено.</p>}
      </div>

      <div className="parents-access-actions">
        <div className="access-mode-control" role="group" aria-label="Режим доступа к компьютеру">
          {ACCESS_MODES.map(({ mode, label }) => (
            <button
              aria-pressed={current === mode}
              disabled={!access.configured || pending || expiryPending}
              key={mode}
              type="button"
              onClick={() => { if (mode !== current) setSelected(mode); }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="parents-access-help">Временная команда действует до московской полуночи.</p>
        {pending && <p className="parents-access-feedback" role="status">Изменяю режим доступа…</p>}
        {expiryPending && <p className="parents-access-feedback" role="status">Обновляю состояние доступа…</p>}
        {expiryError !== null && <p className="parents-access-feedback error" role="alert">{expiryError}</p>}
        {feedback !== null && <p
          className={`parents-access-feedback ${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >{feedback.text}</p>}
      </div>

      {selected !== null && <div className="parents-confirm" role="dialog" aria-modal="true" aria-labelledby="access-confirm-title">
        <form onSubmit={(event) => { void confirm(event); }}>
          <p>Подтверждение</p>
          <h3 id="access-confirm-title">{CONFIRMATIONS[selected].title}</h3>
          <span>{CONFIRMATIONS[selected].text}</span>
          {!pinValid && <small>Введите PIN родителя из 6–12 цифр.</small>}
          <div>
            <button className="secondary" disabled={pending} type="button" onClick={() => setSelected(null)}>Отмена</button>
            <button className="primary" disabled={!pinValid || pending} type="submit">
              {pending ? 'Сохраняю…' : CONFIRMATIONS[selected].action}
            </button>
          </div>
        </form>
      </div>}
    </section>
  );
}

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
  const readGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = ++readGeneration.current;
    api.read()
      .then((loaded) => {
        if (active && readGeneration.current === generation) setDashboard(loaded);
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить сводку');
      });
    return () => {
      active = false;
      if (readGeneration.current === generation) readGeneration.current += 1;
    };
  }, [api]);

  const refreshAfterExpiry = useCallback(async (): Promise<void> => {
    const generation = ++readGeneration.current;
    const loaded = await api.read();
    if (readGeneration.current === generation) {
      setDashboard(loaded);
      setProblem(null);
    }
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
        <p>Те же данные видит ученик. Режим доступа к компьютеру не меняет его учебный план.</p>
      </section>

      <ComputerAccessPanel
        access={dashboard.computerAccess}
        api={api}
        onChanged={(next) => {
          readGeneration.current += 1;
          setDashboard((currentDashboard) => currentDashboard === null ? null : {
            ...currentDashboard,
            computerAccess: {
              ...next,
              configured: currentDashboard.computerAccess.configured,
            },
          });
        }}
        onExpired={refreshAfterExpiry}
      />

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
