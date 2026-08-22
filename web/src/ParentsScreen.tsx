import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DailyGateState } from './home-api';
import {
  ComputerAccessError,
  parentsApiFor,
  type ComputerAccessMode,
  type ParentsApi,
  type ParentsDashboard,
  type ParentsRunAttempt,
  type ParentsRunDetail,
} from './parents-api';
import { isParentPin } from './pin-format';
import { SafeFormula, SafeRichText } from './TaskPrompt';
import { BrandLink } from './BrandMark';
import { courseById, courseColor, type CourseMeta } from './course-meta';

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

const ACCESS_REFRESH_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000] as const;

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
  pinRequired,
  pin,
  onPinChange,
  onChanged,
  onExpired,
}: {
  access: ParentsDashboard['computerAccess'];
  api: ParentsApi;
  /**
   * Спрашивать ли PIN. Вошедшему родителю — нет: он подтверждён паролем, и PIN
   * значит ровно «за детской машиной сейчас родитель». Сервер здесь заодно: с
   * родительской сессией он PIN не проверяет вовсе.
   */
  pinRequired: boolean;
  pin: string;
  onPinChange: (pin: string) => void;
  onChanged: (next: DailyGateState) => void;
  onExpired: () => Promise<ParentsDashboard['computerAccess']>;
}) {
  const [selected, setSelected] = useState<ComputerAccessMode | null>(null);
  const [pending, setPending] = useState(false);
  const [expiryRefresh, setExpiryRefresh] = useState<{
    key: string;
    pending: boolean;
    error: string | null;
    retrying: boolean;
  } | null>(null);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [accessClock, setAccessClock] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const refreshGeneration = useRef(0);
  const refreshAttempt = useRef<{ key: string; count: number }>({ key: '', count: 0 });
  const inFlightRefresh = useRef<{ key: string; generation: number } | null>(null);
  const expiresAt = access.override === null ? Number.NaN : Date.parse(access.override.expiresAt);
  const expiryKey = access.override?.expiresAt ?? null;
  const currentExpiryRefresh = expiryRefresh?.key === expiryKey ? expiryRefresh : null;
  const expiryPending = currentExpiryRefresh?.pending === true;
  const expiryError = currentExpiryRefresh?.error ?? null;
  const overrideActive = Number.isFinite(expiresAt) && expiresAt > accessClock;
  const overrideExpired = access.override !== null && !overrideActive;
  const current = overrideExpired ? null : accessMode(access);
  const status = overrideExpired
    ? {
      eyebrow: expiryPending ? 'Обновляю состояние' : 'Состояние не подтверждено',
      title: expiryPending ? 'Проверяю доступ к компьютеру' : 'Состояние доступа неизвестно',
      note: expiryPending
        ? 'Получаю актуальный режим нового дня.'
        : currentExpiryRefresh?.retrying === true
          ? 'Сервер ещё подтверждает прежний режим. Повторяю проверку.'
          : 'Не получилось получить актуальный режим. Старое состояние не используется.',
    }
    : accessStatus(access);
  // Без PIN проверять нечего: вошедший родитель подтверждён паролем.
  const pinValid = !pinRequired || isParentPin(pin);
  // PIN не настроен — управление закрыто только с детской машины.
  const canChange = !pinRequired || access.configured;

  useEffect(() => {
    if (expiryKey === null || pending) return;
    if (refreshAttempt.current.key !== expiryKey) {
      refreshAttempt.current = { key: expiryKey, count: 0 };
    }
    if (inFlightRefresh.current?.key === expiryKey) return;
    const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 0;
    const attempt = refreshAttempt.current.count;
    const retryDelay = attempt === 0
      ? 0
      : ACCESS_REFRESH_BACKOFF_MS[
        Math.min(attempt - 1, ACCESS_REFRESH_BACKOFF_MS.length - 1)
      ] ?? 30_000;
    const delay = remaining > 0 ? remaining : retryDelay;
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setAccessClock(now);
        if (Number.isFinite(expiresAt) && now < expiresAt) {
          setRefreshCycle((cycle) => cycle + 1);
          return;
        }
        const generation = ++refreshGeneration.current;
        inFlightRefresh.current = { key: expiryKey, generation };
        setSelected(null);
        setExpiryRefresh({ key: expiryKey, pending: true, error: null, retrying: false });
        void onExpired()
          .then((freshAccess) => {
            if (inFlightRefresh.current?.generation !== generation) return;
            inFlightRefresh.current = null;
            const freshExpiresAt = freshAccess.override === null
              ? Number.NaN
              : Date.parse(freshAccess.override.expiresAt);
            const freshStillExpired = freshAccess.override !== null && (
              !Number.isFinite(freshExpiresAt) || freshExpiresAt <= Date.now()
            );
            if (!freshStillExpired) {
              refreshAttempt.current = { key: '', count: 0 };
              setExpiryRefresh(null);
              return;
            }
            refreshAttempt.current.count += 1;
            setExpiryRefresh({ key: expiryKey, pending: false, error: null, retrying: true });
            setRefreshCycle((cycle) => cycle + 1);
          }, (error: unknown) => {
            if (inFlightRefresh.current?.generation !== generation) return;
            inFlightRefresh.current = null;
            refreshAttempt.current.count += 1;
            setExpiryRefresh({
              key: expiryKey,
              pending: false,
              error: error instanceof Error
                ? error.message
                : 'Не получилось обновить состояние доступа',
              retrying: false,
            });
            setRefreshCycle((cycle) => cycle + 1);
          });
      },
      Math.min(2_147_483_647, Math.max(0, delay)),
    );
    return () => window.clearTimeout(timer);
  }, [expiryKey, expiresAt, onExpired, pending, refreshCycle]);

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selected === null || !pinValid || pending || expiryPending) return;
    setPending(true);
    setFeedback(null);
    try {
      const next = pinRequired
        ? await api.changeComputerAccess(selected, pin)
        : await api.changeComputerAccess(selected);
      onChanged(next);
      setExpiryRefresh(null);
      setSelected(null);
      setFeedback({ kind: 'success', text: 'Режим доступа обновлён.' });
    } catch (error: unknown) {
      if (error instanceof ComputerAccessError && error.status === 401) onPinChange('');
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
        {!pinRequired
          ? <p className="parents-access-note">Вы вошли как родитель — PIN не нужен.</p>
          : access.configured
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
              onChange={(event) => onPinChange(event.target.value)}
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
              disabled={!canChange || pending || expiryPending}
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

function readableDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${String(totalSeconds)} сек`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0
    ? `${String(minutes)} мин`
    : `${String(minutes)} мин ${String(seconds)} сек`;
}

function AttemptMaterial({ attempt }: { attempt: ParentsRunAttempt }) {
  if (attempt.material === undefined || attempt.materialFormat === undefined ||
      attempt.materialFormat === 'none') return null;
  return (
    <section className="parents-attempt-material" aria-label="Материал задания">
      {attempt.materialFormat === 'math'
        ? <SafeFormula source={attempt.material} />
        : <SafeRichText as="p" source={attempt.material} />}
    </section>
  );
}

function RunAttempt({
  attempt,
  pin,
  pinRequired,
  api,
  runId,
  onApproved,
}: {
  attempt: ParentsRunAttempt;
  pin: string;
  pinRequired: boolean;
  api: ParentsApi;
  runId: number;
  onApproved: () => Promise<void>;
}) {
  const [approving, setApproving] = useState(false);
  const [approvalProblem, setApprovalProblem] = useState<string | null>(null);
  const prompt = attempt.instruction ?? attempt.question;
  const integrity = attempt.integrity;
  const pinValid = !pinRequired || isParentPin(pin);

  async function approve(): Promise<void> {
    if (integrity === undefined || !pinValid || approving) return;
    setApproving(true);
    setApprovalProblem(null);
    try {
      await api.approveIntegrity(runId, integrity.itemId, pinRequired ? pin : undefined);
      await onApproved();
    } catch (error) {
      setApprovalProblem(error instanceof Error ? error.message : 'Не получилось подтвердить ответ');
    } finally {
      setApproving(false);
    }
  }

  return (
    <article className={`parents-attempt ${attempt.correct ? 'correct' : 'incorrect'}`}>
      <header>
        <div>
          <span>Вопрос {attempt.number}</span>
          {attempt.correction && <em>Исправление</em>}
        </div>
        <time dateTime={`PT${String(attempt.durationMilliseconds / 1_000)}S`}>
          {readableDuration(attempt.durationMilliseconds)}
        </time>
      </header>
      <small>{attempt.topicTitle}</small>
      <h3>{prompt}</h3>
      <AttemptMaterial attempt={attempt} />
      {attempt.choices.length > 0 && <ol className="parents-attempt-choices" type="A">
        {attempt.choices.map((choice) => (
          <li
            className={`${choice === attempt.correctAnswer ? 'expected' : ''}${choice === attempt.studentAnswer ? ' selected' : ''}`}
            key={choice}
          >{choice}</li>
        ))}
      </ol>}
      <div className="parents-answer-comparison">
        <div className={attempt.correct ? 'correct' : 'incorrect'}>
          <span>Ответ ученика</span>
          <strong>{attempt.studentAnswer}</strong>
        </div>
        <div>
          <span>Правильный ответ</span>
          <strong>{attempt.correctAnswer}</strong>
        </div>
      </div>
      {integrity !== undefined && <aside className={`parents-integrity-decision status-${integrity.status}`}>
        <header>
          <span>{integrity.status === 'approved' ? 'Проверка пройдена' : integrity.status === 'retry_required' ? 'Нужен повтор' : 'Идёт проверка'}</span>
          {integrity.confidence !== undefined && <strong>{Math.round(integrity.confidence * 100)}% уверенности</strong>}
        </header>
        {integrity.reason !== undefined && <p>{integrity.reason}</p>}
        {integrity.decision !== undefined && <small>
          Решение: {integrity.decision === 'junk' ? 'похоже на халтуру' : integrity.decision === 'doubtful' ? 'сомнительно' : 'осмысленный ответ'}
          {integrity.reviewedBy === 'parent' ? ' · подтверждено родителем' : integrity.reviewedBy === 'codex' ? ' · Codex' : ''}
        </small>}
        {integrity.status !== 'approved' && <div>
          <button className="secondary" type="button" disabled={!pinValid || approving} onClick={() => void approve()}>
            {approving ? 'Подтверждаю…' : 'Ответ осмысленный'}
          </button>
          {!pinValid && <small>Введите PIN родителя в блоке доступа выше.</small>}
        </div>}
        {approvalProblem !== null && <p className="parents-access-feedback error" role="alert">{approvalProblem}</p>}
      </aside>}
      {attempt.hint !== undefined && <aside className="parents-attempt-hint"><span>Использована подсказка</span><p>{attempt.hint}</p></aside>}
      {attempt.explanation !== '' && <details className="parents-attempt-explanation">
        <summary>Показать объяснение</summary>
        <SafeRichText source={attempt.explanation} />
      </details>}
    </article>
  );
}

function RunDetail({
  detail,
  pin,
  pinRequired,
  api,
  onApproved,
}: {
  detail: ParentsRunDetail;
  pin: string;
  pinRequired: boolean;
  api: ParentsApi;
  onApproved: () => Promise<void>;
}) {
  return (
    <div className="parents-run-detail">
      <header>
        <div><span>Всего ответов</span><strong>{detail.attempts.length}</strong></div>
        <div><span>Верных в итоге</span><strong>{detail.correct} из {detail.total}</strong></div>
        <div><span>Время на ответы</span><strong>{readableDuration(detail.activeMilliseconds)}</strong></div>
      </header>
      {detail.attempts.length === 0
        ? <p className="parents-run-detail-empty">В этом занятии не сохранено ответов.</p>
        : <div className="parents-attempts">{detail.attempts.map((attempt) => (
          <RunAttempt
            attempt={attempt}
            pin={pin}
            pinRequired={pinRequired}
            api={api}
            runId={detail.runId}
            onApproved={onApproved}
            key={attempt.number}
          />
        ))}</div>}
    </div>
  );
}

function ActivityItem({
  item,
  courses,
  api,
  pin,
  pinRequired,
  onDashboardChanged,
}: {
  item: ParentsDashboard['activity'][number];
  courses: readonly CourseMeta[];
  api: ParentsApi;
  pin: string;
  pinRequired: boolean;
  onDashboardChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ParentsRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panelId = `parents-run-${String(item.runId)}`;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setProblem(null);
    try {
      setDetail(await api.readRun(item.runId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось загрузить занятие');
    } finally {
      setLoading(false);
    }
  }, [api, item.runId]);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next && detail === null && !loading && problem === null) void load();
  }

  return (
    <li className={`activity-${item.kind}${open ? ' open' : ''}`}>
      <button aria-controls={panelId} aria-expanded={open} className="parents-activity-toggle" type="button" onClick={toggle}>
        <span className="parents-activity-summary">
          <span><strong>{KIND_NAMES[item.kind]}</strong><small>{courseById(courses, item.subject).title}</small></span>
          <span>{item.correct} из {item.total} · {item.activeMinutes} мин
            {item.kind === 'boss' && ` · ${item.bossOutcome === 'won' ? 'победа' : 'попытка'}`}</span>
        </span>
        <time dateTime={item.finishedAt}>{activityDateFormatter.format(new Date(item.finishedAt))}</time>
        <span className="parents-activity-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && <div className="parents-activity-detail" id={panelId}>
        {loading && <p role="status">Загружаю вопросы и ответы…</p>}
        {problem !== null && <div className="parents-run-detail-problem" role="alert">
          <p>{problem}</p>
          <button type="button" onClick={() => void load()}>Повторить</button>
        </div>}
        {detail !== null && <RunDetail
          detail={detail}
          pin={pin}
          pinRequired={pinRequired}
          api={api}
          onApproved={async () => { await load(); await onDashboardChanged(); }}
        />}
      </div>}
    </li>
  );
}

function IntegrityReviewItem({
  item,
  courses,
  api,
  pin,
  pinRequired,
  onDashboardChanged,
}: {
  item: NonNullable<ParentsDashboard['integrityReviews']>[number];
  courses: readonly CourseMeta[];
  api: ParentsApi;
  pin: string;
  pinRequired: boolean;
  onDashboardChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ParentsRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panelId = `parents-integrity-${String(item.runId)}`;
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setProblem(null);
    try {
      setDetail(await api.readRun(item.runId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось загрузить проверку');
    } finally {
      setLoading(false);
    }
  }, [api, item.runId]);

  return <li className={`parents-integrity-review${open ? ' open' : ''}`}>
    <button
      aria-controls={panelId}
      aria-expanded={open}
      className="parents-activity-toggle"
      type="button"
      onClick={() => { const next = !open; setOpen(next); if (next && detail === null) void load(); }}
    >
      <span className="parents-activity-summary">
        <span><strong>{KIND_NAMES[item.kind]}</strong><small>{courseById(courses, item.subject).title}</small></span>
        <span>{item.flagged} вопросов · {item.retryRequired > 0 ? `${String(item.retryRequired)} нужно повторить` : 'идёт проверка'}</span>
      </span>
      <time dateTime={item.startedAt}>{activityDateFormatter.format(new Date(item.startedAt))}</time>
      <span className="parents-activity-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="parents-activity-detail" id={panelId}>
      {loading && <p role="status">Загружаю проверку ответов…</p>}
      {problem !== null && <div className="parents-run-detail-problem" role="alert">
        <p>{problem}</p><button type="button" onClick={() => void load()}>Повторить</button>
      </div>}
      {detail !== null && <RunDetail
        detail={detail}
        pin={pin}
        pinRequired={pinRequired}
        api={api}
        onApproved={async () => { await load(); await onDashboardChanged(); }}
      />}
    </div>}
  </li>;
}

function Flags({ dashboard }: { dashboard: ParentsDashboard }) {
  const observations = [
    ...(dashboard.flags.threeFullDaysWithoutRun ? ['Три полных дня без обычных забегов.'] : []),
    ...dashboard.flags.forecastNotGrowing.map((subject) =>
      `Прогноз по курсу «${courseById(dashboard.courses, subject).title}» не растёт пять дней.`),
    ...dashboard.flags.reduceLoad.map((subject) =>
      `${courseById(dashboard.courses, subject).title}: нижняя граница прогноза уже не ниже 4,0 — нагрузку можно обсудить.`),
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

export interface ParentsScreenProps {
  /** Чья сводка. Ребёнок назван всегда: у родителя их может быть несколько. */
  childId: string;
  api?: ParentsApi;
  /**
   * Спрашивать ли PIN на смене режима доступа. По умолчанию да: экран открыт с
   * детской машины, где вошедшего родителя нет.
   */
  pinRequired?: boolean;
  /** Остальные дети родителя. Пусто у детского предъявителя: он видит только себя. */
  siblings?: Array<{ id: string; name: string }>;
  onSelectChild?: (childId: string) => void;
  /** Куда вернуться. У ребёнка это план дня, у родителя — состав семьи. */
  home?: { label: string; onClick: () => void };
}

export function ParentsScreen({
  childId,
  api: providedApi,
  pinRequired = true,
  siblings = [],
  onSelectChild,
  home,
}: ParentsScreenProps) {
  // Свой адаптер на ребёнка, а не общий: собранный в теле функции заново на
  // каждый рендер, он перезапускал бы чтение сводки бесконечно.
  const api = useMemo(() => providedApi ?? parentsApiFor(childId), [providedApi, childId]);
  const [dashboard, setDashboard] = useState<ParentsDashboard | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const readGeneration = useRef(0);

  const reloadDashboard = useCallback(async (): Promise<void> => {
    const generation = ++readGeneration.current;
    const loaded = await api.read();
    if (readGeneration.current === generation) {
      setDashboard(loaded);
      setProblem(null);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    const generation = ++readGeneration.current;
    // Смена ребёнка гасит прежнюю сводку до прихода новой: иначе переключатель
    // на секунду показывал бы чужие цифры под новым именем.
    setDashboard(null);
    setProblem(null);
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

  const refreshAfterExpiry = useCallback(async (): Promise<ParentsDashboard['computerAccess']> => {
    const generation = ++readGeneration.current;
    const loaded = await api.read();
    if (readGeneration.current === generation) {
      setDashboard(loaded);
      setProblem(null);
    }
    return loaded.computerAccess;
  }, [api]);

  // Возврат остаётся и в отказе, и в ожидании: родитель попал сюда из состава
  // семьи, и экран из одной красной строки без выхода — тупик, из которого
  // можно только перезагрузить страницу.
  const back = home === undefined
    ? <a className="parents-home" href="/">К плану дня</a>
    : <button className="parents-home" type="button" onClick={home.onClick}>{home.label}</button>;

  if (problem !== null) {
    return <main className="parents-state"><p role="alert">{problem}</p>{back}</main>;
  }
  if (dashboard === null) {
    return (
      <main className="parents-state" role="status">
        <p>Собираю сводку за неделю…</p>
        {back}
      </main>
    );
  }

  const days = windowDays(dashboard);
  const maxMinutes = Math.max(1, ...days.map((item) => item.minutes));

  return (
    <main className="parents-shell">
      <header className="parents-header">
        <BrandLink />
        <div><span>Открытая сводка</span><strong>Для ученика и родителей</strong></div>
        {siblings.length > 1 && <label className="parents-switch">
          <span>Ребёнок</span>
          <select
            value={childId}
            onChange={(event) => onSelectChild?.(event.target.value)}
          >
            {siblings.map((sibling) => (
              <option key={sibling.id} value={sibling.id}>{sibling.name}</option>
            ))}
          </select>
        </label>}
        {back}
      </header>

      <section className="parents-intro">
        <p className="home-kicker">Последние семь дней</p>
        <h1>Картина подготовки без приукрашивания</h1>
        <p>Те же данные видит ученик. Режим доступа к компьютеру не меняет его учебный план.</p>
      </section>

      <ComputerAccessPanel
        access={dashboard.computerAccess}
        api={api}
        pinRequired={pinRequired}
        pin={pin}
        onPinChange={setPin}
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

      {(dashboard.integrityReviews ?? []).length > 0 && <section className="parents-panel parents-integrity" aria-labelledby="parents-integrity-title">
        <div className="section-heading"><p>До зачёта занятия</p><h2 id="parents-integrity-title">Проверка ответов</h2></div>
        <p className="parents-integrity-intro">Эти занятия пока не открывают доступ к компьютеру. Можно посмотреть решения Codex или подтвердить осмысленный ответ вручную.</p>
        <ol className="parents-activity">{(dashboard.integrityReviews ?? []).map((item) => (
          <IntegrityReviewItem
            api={api}
            courses={dashboard.courses}
            item={item}
            pin={pin}
            pinRequired={pinRequired}
            onDashboardChanged={reloadDashboard}
            key={item.runId}
          />
        ))}</ol>
      </section>}

      <section className="parents-panel" aria-labelledby="parents-forecast-title">
        <div className="section-heading"><p>Прогноз, не оценка</p><h2 id="parents-forecast-title">По предметам</h2></div>
        {dashboard.courses.length === 0
          ? <p className="parents-empty">Учебные курсы пока не назначены. Выберите их в составе семьи.</p>
          : <div className="parents-forecasts">
          {dashboard.courses.map((course) => {
            const forecast = dashboard.forecasts.find((item) => item.subject === course.courseId);
            return (
              <article
                key={course.courseId}
                aria-label={`Прогноз: ${course.title}`}
                style={{ borderColor: courseColor(course.courseId) }}
              >
                <span>{course.title}{course.grade === '' ? '' : ` · ${course.grade}`}</span>
                {forecast === undefined ? <p>Прогноз пока недоступен</p> : <>
                  <strong>{forecast.score.toFixed(1)} <small>± {forecast.band.toFixed(1)}</small></strong>
                  <p>Диапазон {forecast.low.toFixed(1)}–{forecast.high.toFixed(1)}</p>
                  <p>За 7 дней: {forecast.delta === undefined ? 'нет точки сравнения' : signed(forecast.delta)}</p>
                  {forecast.preliminary && <em>Предварительный прогноз: данных пока мало</em>}
                </>}
              </article>
            );
          })}
          </div>}
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
              <li key={`${gap.subject}:${gap.title}`}><span>{gap.title}</span><small>{courseById(dashboard.courses, gap.subject).title}</small></li>
            ))}</ol>}
        </section>

        <section className="parents-panel" aria-labelledby="parents-activity-title">
          <div className="section-heading"><p>История занятий</p><h2 id="parents-activity-title">Лента забегов</h2></div>
          {dashboard.activity.length === 0
            ? <p className="parents-empty">За эту неделю завершённых забегов пока нет.</p>
            : <ol className="parents-activity">{dashboard.activity.map((item) => (
              <ActivityItem
                api={api}
                courses={dashboard.courses}
                item={item}
                pin={pin}
                pinRequired={pinRequired}
                onDashboardChanged={reloadDashboard}
                key={item.runId}
              />
            ))}</ol>}
        </section>
      </div>

      <Flags dashboard={dashboard} />
    </main>
  );
}
