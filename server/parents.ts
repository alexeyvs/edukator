import type { Database } from 'better-sqlite3';
import type { Subject } from './db.js';
import type { TopicGraph } from './curriculum.js';
import { computeForecast, MIN_SCORE, MAX_SCORE } from './forecast.js';
import { confidenceAt, readTopicStates } from './mastery.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const STALE_RUN_DAYS = 3;
const STALLED_FORECAST_DAYS = 5;
export const PARENTS_PLANNED_MINUTES = 630;

type RunKind = 'run' | 'triage' | 'boss';
type BossOutcome = 'won' | 'lost';

interface ParentsForecast {
  subject: Subject;
  score: number;
  band: number;
  low: number;
  high: number;
  preliminary: boolean;
  currentSnapshot?: { score: number; band: number; createdAt: string };
  delta?: number;
}

interface ParentsGap {
  title: string;
  subject: Subject;
}

interface ParentsActivity {
  kind: RunKind;
  subject: Subject;
  startedAt: string;
  finishedAt: string;
  total: number;
  correct: number;
  activeMinutes: number;
  bossOutcome?: BossOutcome;
}

/** Единый публичный контракт, который целиком возвращает `GET /api/parents`. */
export interface ParentsDashboard {
  generatedAt: string;
  window: { since: string; until: string };
  forecasts: ParentsForecast[];
  time: {
    plannedMinutes: number;
    actualMinutes: number;
    daily: { date: string; minutes: number }[];
  };
  gaps: ParentsGap[];
  activity: ParentsActivity[];
  flags: {
    threeFullDaysWithoutRun: boolean;
    forecastNotGrowing: Subject[];
    reduceLoad: Subject[];
  };
}

interface RunRow {
  id: number;
  subject: string;
  kind: string;
  started_at: string;
  finished_at: string;
  total: number;
  correct: number;
}

interface AttemptRow {
  run_id: number | null;
  topic_id: string;
  duration_ms: number;
  created_at: string;
}

interface SnapshotRow {
  subject: string;
  score: number;
  band: number;
  created_at: string;
}

interface BossOutcomeRow { run_id: number; status: string }

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});

function requireDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Дашборд родителей: повреждённое время ${label} (${value})`);
  }
  return date;
}

function subjectOf(value: string, label: string): Subject {
  if (value !== 'math' && value !== 'russian' && value !== 'english') {
    throw new Error(`Дашборд родителей: неизвестный предмет ${label} (${value})`);
  }
  return value;
}

function kindOf(value: string): RunKind {
  if (value !== 'run' && value !== 'triage' && value !== 'boss') {
    throw new Error(`Дашборд родителей: неизвестный kind (${value})`);
  }
  return value;
}

function moscowDay(date: Date): string {
  return dayFormatter.format(date);
}

function previousDay(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, (date as number) - count))
    .toISOString().slice(0, 10);
}

function roundMinutes(milliseconds: number): number {
  return Math.round((milliseconds / 60_000) * 100) / 100;
}

/**
 * Строит read model без побочных эффектов. `now` обязателен: окно и каждый
 * запрос получают явные ISO-границы и не зависят от часов SQLite.
 */
export function readParentsDashboard(
  db: Database,
  graph: TopicGraph,
  now: Date,
): ParentsDashboard {
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Дашборд родителей: некорректное now (${String(now)})`);
  }
  const until = now.toISOString();
  const sinceDate = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const since = sinceDate.toISOString();

  // Читаем и проверяем историю до фильтрации. Иначе битая строка с не-ISO датой
  // выпала бы из лексикографического WHERE и дала правдоподобный неполный отчёт.
  const runs = db.prepare<[], RunRow>(
    `SELECT id, subject, kind, started_at, finished_at, total, correct
       FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at, id`,
  ).all();
  const runById = new Map<number, { row: RunRow; subject: Subject; kind: RunKind }>();
  for (const row of runs) {
    const subject = subjectOf(row.subject, `runs.id=${row.id}`);
    const kind = kindOf(row.kind);
    const started = requireDate(row.started_at, `runs.started_at id=${row.id}`);
    const finished = requireDate(row.finished_at, `runs.finished_at id=${row.id}`);
    if (finished < started || row.total < 0 || row.correct < 0 || row.correct > row.total) {
      throw new Error(`Дашборд родителей: повреждённый завершённый run ${row.id}`);
    }
    runById.set(row.id, { row, subject, kind });
  }

  const attempts = db.prepare<[], AttemptRow>(
    'SELECT run_id, topic_id, duration_ms, created_at FROM attempts ORDER BY created_at, id',
  ).all();
  for (const attempt of attempts) {
    requireDate(attempt.created_at, 'attempts.created_at');
    if (!Number.isSafeInteger(attempt.duration_ms) || attempt.duration_ms < 0) {
      throw new Error(`Дашборд родителей: повреждённая длительность попытки (${attempt.duration_ms})`);
    }
    if (!graph.byId.has(attempt.topic_id)) {
      throw new Error(`Дашборд родителей: попытка с неизвестной темой (${attempt.topic_id})`);
    }
    if (attempt.run_id !== null && !runById.has(attempt.run_id)) {
      const unfinished = db.prepare<[number], { id: number }>('SELECT id FROM runs WHERE id = ?').get(attempt.run_id);
      if (unfinished === undefined) {
        throw new Error(`Дашборд родителей: попытка с неизвестным run (${attempt.run_id})`);
      }
    }
  }

  const snapshots = db.prepare<[], SnapshotRow>(
    'SELECT subject, score, band, created_at FROM forecast_snapshots ORDER BY created_at, id',
  ).all();
  for (const snapshot of snapshots) {
    if (snapshot.subject !== 'overall') subjectOf(snapshot.subject, 'forecast_snapshots');
    requireDate(snapshot.created_at, 'forecast_snapshots.created_at');
    if (!Number.isFinite(snapshot.score) || snapshot.score < MIN_SCORE || snapshot.score > MAX_SCORE ||
        !Number.isFinite(snapshot.band) || snapshot.band < 0 || snapshot.band > 1) {
      throw new Error('Дашборд родителей: повреждённый снимок прогноза');
    }
  }

  const states = readTopicStates(db);
  const forecasts: ParentsForecast[] = [];
  const forecastNotGrowing: Subject[] = [];
  const reduceLoad: Subject[] = [];
  const stalledSince = new Date(now.getTime() - STALLED_FORECAST_DAYS * DAY_MS).toISOString();

  for (const subject of graph.subjects) {
    const value = computeForecast(graph.bySubject.get(subject) ?? [], states, now);
    if (value === null) continue;
    const history = snapshots.filter((item) => item.subject === subject && item.created_at <= until);
    const current = history.at(-1);
    const baseline = history.filter((item) => item.created_at <= since).at(-1);
    const forecast: ParentsForecast = {
      subject,
      score: value.score,
      band: value.band,
      low: value.low,
      high: value.high,
      preliminary: value.band > 0,
      ...(current === undefined ? {} : {
        currentSnapshot: { score: current.score, band: current.band, createdAt: current.created_at },
      }),
      ...(baseline === undefined ? {} : { delta: value.score - baseline.score }),
    };
    forecasts.push(forecast);
    if (value.score - value.band >= 4) reduceLoad.push(subject);

    const stalledBaseline = history.filter((item) => item.created_at <= stalledSince).at(-1);
    const hasOrdinaryStudy = runs.some((item) =>
      item.kind === 'run' && item.subject === subject &&
      item.finished_at >= stalledSince && item.finished_at <= until);
    if (hasOrdinaryStudy && stalledBaseline !== undefined && current !== undefined &&
        current.created_at > stalledBaseline.created_at && current.score <= stalledBaseline.score) {
      forecastNotGrowing.push(subject);
    }
  }

  const windowAttempts = attempts.filter((attempt) =>
    attempt.created_at >= since && attempt.created_at <= until);
  const actualMilliseconds = windowAttempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0);
  const dailyMilliseconds = new Map<string, number>();
  const runMilliseconds = new Map<number, number>();
  for (const attempt of windowAttempts) {
    const day = moscowDay(new Date(attempt.created_at));
    dailyMilliseconds.set(day, (dailyMilliseconds.get(day) ?? 0) + attempt.duration_ms);
    if (attempt.run_id !== null) {
      runMilliseconds.set(attempt.run_id, (runMilliseconds.get(attempt.run_id) ?? 0) + attempt.duration_ms);
    }
  }

  const gaps = graph.order
    .flatMap((topic, order) => {
      const state = states.get(topic.id);
      if (state === undefined || state.attempts === 0 || confidenceAt(state, now) <= 0) return [];
      return [{
        title: topic.title,
        subject: topic.subject,
        priority: (1 - state.mastery) * topic.examWeight,
        order,
      }];
    })
    .sort((left, right) => right.priority - left.priority || left.order - right.order)
    .slice(0, 5)
    .map(({ title, subject }) => ({ title, subject }));

  const bossOutcomes = new Map<number, BossOutcome>();
  for (const row of db.prepare<[], BossOutcomeRow>(
    "SELECT run_id, status FROM boss_batches WHERE run_id IS NOT NULL AND status IN ('won', 'lost')",
  ).all()) {
    if (row.status !== 'won' && row.status !== 'lost') {
      throw new Error(`Дашборд родителей: неизвестный исход босса (${row.status})`);
    }
    if (bossOutcomes.has(row.run_id)) {
      throw new Error(`Дашборд родителей: несколько исходов boss run ${row.run_id}`);
    }
    bossOutcomes.set(row.run_id, row.status);
  }

  const activity = [...runById.entries()]
    .filter(([, item]) => item.row.finished_at >= since && item.row.finished_at <= until)
    .sort((left, right) => right[1].row.finished_at.localeCompare(left[1].row.finished_at) || right[0] - left[0])
    .map(([id, item]): ParentsActivity => {
      const bossOutcome = bossOutcomes.get(id);
      if (item.kind === 'boss' && bossOutcome === undefined) {
        throw new Error(`Дашборд родителей: завершённый boss run ${id} без исхода`);
      }
      return {
        kind: item.kind,
        subject: item.subject,
        startedAt: item.row.started_at,
        finishedAt: item.row.finished_at,
        total: item.row.total,
        correct: item.row.correct,
        activeMinutes: roundMinutes(runMilliseconds.get(id) ?? 0),
        ...(bossOutcome === undefined ? {} : { bossOutcome }),
      };
    });

  const today = moscowDay(now);
  const completedRunDays = new Set(runs.filter((run) => run.kind === 'run').map((run) =>
    moscowDay(new Date(run.finished_at))));
  const threeFullDaysWithoutRun = Array.from({ length: STALE_RUN_DAYS }, (_, index) =>
    previousDay(today, index + 1)).every((day) => !completedRunDays.has(day));

  return {
    generatedAt: until,
    window: { since, until },
    forecasts,
    time: {
      plannedMinutes: PARENTS_PLANNED_MINUTES,
      actualMinutes: roundMinutes(actualMilliseconds),
      daily: [...dailyMilliseconds.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, milliseconds]) => ({ date, minutes: roundMinutes(milliseconds) })),
    },
    gaps,
    activity,
    flags: { threeFullDaysWithoutRun, forecastNotGrowing, reduceLoad },
  };
}
