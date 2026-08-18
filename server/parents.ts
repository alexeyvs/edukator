import type { Database } from 'better-sqlite3';
import type { Subject } from './db.js';
import type { TopicGraph } from './curriculum.js';
import { computeForecast, MIN_SCORE, MAX_SCORE } from './forecast.js';
import { confidenceAt, readTopicStates } from './mastery.js';
import { isRunKind, type RunKind } from './run.js';
import { readDailyGate, type DailyGateState } from './daily-gate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const STALE_RUN_DAYS = 3;
const STALLED_FORECAST_DAYS = 5;
export const PARENTS_PLANNED_MINUTES = 630;

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
  runId: number;
  kind: RunKind;
  subject: Subject;
  startedAt: string;
  finishedAt: string;
  total: number;
  correct: number;
  activeMinutes: number;
  bossOutcome?: BossOutcome;
}

export interface ParentsIntegrityReview {
  runId: number;
  kind: 'run' | 'lesson';
  subject: Subject;
  startedAt: string;
  status: 'screening' | 'reviewing' | 'needs_retry' | 'passed';
  flagged: number;
  retryRequired: number;
}

export interface ParentsRunAttempt {
  number: number;
  topicTitle: string;
  answerFormat: 'number' | 'text' | 'choice';
  question: string;
  instruction?: string;
  material?: string;
  materialFormat?: 'none' | 'text' | 'math';
  choices: string[];
  studentAnswer: string;
  correctAnswer: string;
  explanation: string;
  hint?: string;
  correct: boolean;
  correction: boolean;
  durationMilliseconds: number;
  answeredAt: string;
  current: boolean;
  integrity?: {
    itemId: number;
    status: 'pending' | 'retry_required' | 'approved';
    decision?: 'meaningful' | 'doubtful' | 'junk';
    confidence?: number;
    reason?: string;
    reviewedBy?: 'codex' | 'parent' | 'heuristic';
  };
}

export interface ParentsRunDetail {
  runId: number;
  kind: RunKind;
  subject: Subject;
  startedAt: string;
  finishedAt?: string;
  total: number;
  correct: number;
  activeMilliseconds: number;
  attempts: ParentsRunAttempt[];
  integrityStatus?: 'screening' | 'reviewing' | 'needs_retry' | 'passed';
}

/** Единый публичный контракт, который целиком возвращает `GET /api/parents`. */
export interface ParentsDashboard {
  generatedAt: string;
  computerAccess: DailyGateState;
  window: { since: string; until: string };
  forecasts: ParentsForecast[];
  time: {
    plannedMinutes: number;
    actualMinutes: number;
    daily: { date: string; minutes: number }[];
  };
  gaps: ParentsGap[];
  activity: ParentsActivity[];
  integrityReviews: ParentsIntegrityReview[];
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
  summary: string | null;
  total: number;
  correct: number;
}

interface AttemptRow {
  run_id: number | null;
  topic_id: string;
  duration_ms: number;
  created_at: string;
}

interface AttemptDetailRow extends AttemptRow {
  id: number;
  task_id: number;
  answer: string;
  is_correct: number;
  hint_used: number;
  question: string;
  instruction: string | null;
  material: string | null;
  material_format: string | null;
  choices: string | null;
  correct_answer: string;
  hint: string | null;
  explain: string | null;
  is_current: number;
}

interface IntegrityDetailRow {
  id: number;
  attempt_id: number;
  status: 'pending' | 'retry_required' | 'approved';
  decision: 'meaningful' | 'doubtful' | 'junk' | null;
  confidence: number | null;
  reason: string | null;
  reviewed_by: 'codex' | 'parent' | 'heuristic' | null;
}

interface RunDetailRow extends Omit<RunRow, 'finished_at'> {
  finished_at: string | null;
  integrity_status: 'screening' | 'reviewing' | 'needs_retry' | 'passed' | null;
}

interface SnapshotRow {
  subject: string;
  score: number;
  band: number;
  created_at: string;
}

interface BossOutcomeRow { run_id: number; status: string }
type ValidatedRun = { row: RunRow; subject: Subject; kind: RunKind };

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
  if (!isRunKind(value)) {
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
  return Math.round(milliseconds / 600) / 100;
}

function reconciledDailyMinutes(dailyMilliseconds: Map<string, number>): { date: string; minutes: number }[] {
  const days = [...dailyMilliseconds.entries()].sort(([left], [right]) => left.localeCompare(right));
  const roundedTotal = Math.round(days.reduce((sum, [, milliseconds]) => sum + milliseconds, 0) / 600);
  const hundredths = days.map(([date, milliseconds]) => ({
    date,
    hundredths: Math.floor(milliseconds / 600),
    remainder: milliseconds % 600,
  }));
  const remaining = roundedTotal - hundredths.reduce((sum, day) => sum + day.hundredths, 0);
  const recipients = [...hundredths].sort((left, right) =>
    right.remainder - left.remainder || left.date.localeCompare(right.date));
  for (let index = 0; index < remaining; index += 1) {
    const recipient = recipients[index];
    if (recipient !== undefined) recipient.hundredths += 1;
  }
  return hundredths.map(({ date, hundredths: value }) => ({ date, minutes: value / 100 }));
}

function readRuns(db: Database, since: string, until: string): { rows: RunRow[]; byId: Map<number, ValidatedRun> } {
  const invalid = db.prepare<[], { id: number }>(
    `SELECT id FROM runs WHERE finished_at IS NOT NULL AND (
       total < 0 OR correct < 0 OR correct > total OR
       length(started_at) <> 24 OR substr(started_at, 11, 1) <> 'T' OR substr(started_at, 24, 1) <> 'Z' OR
       length(finished_at) <> 24 OR substr(finished_at, 11, 1) <> 'T' OR substr(finished_at, 24, 1) <> 'Z'
     ) LIMIT 1`,
  ).get();
  if (invalid !== undefined) {
    throw new Error(`Дашборд родителей: повреждённое время или счёт завершённого run ${invalid.id}`);
  }
  const rows = db.prepare<[string, string], RunRow>(
    `SELECT id, subject, kind, started_at, finished_at, summary, total, correct
       FROM runs WHERE finished_at IS NOT NULL
         AND finished_at >= ? AND finished_at <= ? ORDER BY finished_at, id`,
  ).all(since, until);
  const byId = new Map<number, ValidatedRun>();
  for (const row of rows) {
    const subject = subjectOf(row.subject, `runs.id=${row.id}`);
    const kind = kindOf(row.kind);
    if (requireDate(row.finished_at, `runs.finished_at id=${row.id}`) <
        requireDate(row.started_at, `runs.started_at id=${row.id}`)) {
      throw new Error(`Дашборд родителей: повреждённый завершённый run ${row.id}`);
    }
    if (kind === 'boss' || row.summary !== null) byId.set(row.id, { row, subject, kind });
  }
  return { rows, byId };
}

function validateAttempts(attempts: AttemptRow[], graph: TopicGraph): AttemptRow[] {
  for (const attempt of attempts) {
    requireDate(attempt.created_at, 'attempts.created_at');
    if (!Number.isSafeInteger(attempt.duration_ms) || attempt.duration_ms < 0) {
      throw new Error(`Дашборд родителей: повреждённая длительность попытки (${attempt.duration_ms})`);
    }
    if (!graph.byId.has(attempt.topic_id)) {
      throw new Error(`Дашборд родителей: попытка с неизвестной темой (${attempt.topic_id})`);
    }
  }
  return attempts;
}

function readWindowAttempts(db: Database, graph: TopicGraph, since: string, until: string): AttemptRow[] {
  return validateAttempts(db.prepare<[string, string], AttemptRow>(
    `SELECT run_id, topic_id, duration_ms, created_at FROM attempts
      WHERE created_at >= ? AND created_at <= ? ORDER BY created_at, id`,
  ).all(since, until), graph);
}

function readSnapshots(db: Database, since: string, until: string): SnapshotRow[] {
  const rows = db.prepare<[string, string, string], SnapshotRow>(
    `SELECT subject, score, band, created_at FROM forecast_snapshots AS current
      WHERE current.created_at <= ? AND (
        current.created_at >= ? OR current.id IN (
          SELECT baseline.id FROM forecast_snapshots AS baseline
           WHERE baseline.subject = current.subject AND baseline.created_at <= ?
           ORDER BY baseline.created_at DESC, baseline.id DESC LIMIT 1
        )
      ) ORDER BY created_at, id`,
  ).all(until, since, since);
  for (const row of rows) {
    if (row.subject !== 'overall') subjectOf(row.subject, 'forecast_snapshots');
    requireDate(row.created_at, 'forecast_snapshots.created_at');
    if (!Number.isFinite(row.score) || row.score < MIN_SCORE || row.score > MAX_SCORE ||
        !Number.isFinite(row.band) || row.band < 0 || row.band > 1) {
      throw new Error('Дашборд родителей: повреждённый снимок прогноза');
    }
  }
  return rows;
}

function buildForecasts(
  graph: TopicGraph,
  states: ReturnType<typeof readTopicStates>,
  snapshots: SnapshotRow[],
  runs: RunRow[],
  now: Date,
  since: string,
  until: string,
): Pick<ParentsDashboard, 'forecasts'> & Pick<ParentsDashboard['flags'], 'forecastNotGrowing' | 'reduceLoad'> {
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
    forecasts.push({
      subject, score: value.score, band: value.band, low: value.low, high: value.high,
      preliminary: value.band >= 0.75,
      ...(current === undefined ? {} : {
        currentSnapshot: { score: current.score, band: current.band, createdAt: current.created_at },
      }),
      ...(baseline === undefined ? {} : { delta: value.score - baseline.score }),
    });
    if (value.score - value.band >= 4) reduceLoad.push(subject);
    const stalledBaseline = history.filter((item) => item.created_at <= stalledSince).at(-1);
    const studied = runs.some((run) => run.kind === 'run' && run.subject === subject &&
      run.summary !== null && run.finished_at >= stalledSince && run.finished_at <= until);
    if (studied && stalledBaseline !== undefined && current !== undefined &&
        current.created_at > stalledBaseline.created_at && current.score <= stalledBaseline.score) {
      forecastNotGrowing.push(subject);
    }
  }
  return { forecasts, forecastNotGrowing, reduceLoad };
}

function buildTime(attempts: AttemptRow[]): ParentsDashboard['time'] {
  const daily = new Map<string, number>();
  let total = 0;
  for (const attempt of attempts) {
    total += attempt.duration_ms;
    const day = moscowDay(new Date(attempt.created_at));
    daily.set(day, (daily.get(day) ?? 0) + attempt.duration_ms);
  }
  return {
    plannedMinutes: PARENTS_PLANNED_MINUTES,
    actualMinutes: roundMinutes(total),
    daily: reconciledDailyMinutes(daily),
  };
}

function buildGaps(
  graph: TopicGraph,
  states: ReturnType<typeof readTopicStates>,
  now: Date,
): ParentsGap[] {
  return graph.order.flatMap((topic, order) => {
    const state = states.get(topic.id);
    if (state === undefined || state.attempts === 0 || confidenceAt(state, now) <= 0) return [];
    return [{ title: topic.title, subject: topic.subject, priority: (1 - state.mastery) * topic.examWeight, order }];
  }).sort((left, right) => right.priority - left.priority || left.order - right.order)
    .slice(0, 5).map(({ title, subject }) => ({ title, subject }));
}

function readActivity(
  db: Database,
  graph: TopicGraph,
  runs: Map<number, ValidatedRun>,
  since: string,
  until: string,
): ParentsActivity[] {
  const attempts = validateAttempts(db.prepare<[string, string], AttemptRow>(
    `SELECT attempts.run_id, attempts.topic_id, attempts.duration_ms, attempts.created_at
       FROM attempts JOIN runs ON runs.id = attempts.run_id
      WHERE runs.finished_at >= ? AND runs.finished_at <= ?
        AND (runs.kind = 'boss' OR runs.summary IS NOT NULL)
      ORDER BY attempts.created_at, attempts.id`,
  ).all(since, until), graph);
  const milliseconds = new Map<number, number>();
  for (const attempt of attempts) {
    if (attempt.run_id !== null && runs.has(attempt.run_id)) {
      milliseconds.set(attempt.run_id, (milliseconds.get(attempt.run_id) ?? 0) + attempt.duration_ms);
    }
  }
  const outcomes = new Map<number, BossOutcome>();
  for (const row of db.prepare<[string, string], BossOutcomeRow>(
    `SELECT boss_batches.run_id, boss_batches.status FROM boss_batches
      JOIN runs ON runs.id = boss_batches.run_id
     WHERE runs.finished_at >= ? AND runs.finished_at <= ?
       AND boss_batches.status IN ('won', 'lost')`,
  ).all(since, until)) {
    if ((row.status !== 'won' && row.status !== 'lost') || outcomes.has(row.run_id)) {
      throw new Error(`Дашборд родителей: повреждён исход boss run ${row.run_id}`);
    }
    outcomes.set(row.run_id, row.status);
  }
  return [...runs.entries()]
    .sort((left, right) => right[1].row.finished_at.localeCompare(left[1].row.finished_at) || right[0] - left[0])
    .map(([id, item]) => {
      const bossOutcome = outcomes.get(id);
      if (item.kind === 'boss' && bossOutcome === undefined) {
        throw new Error(`Дашборд родителей: завершённый boss run ${id} без исхода`);
      }
      return {
        runId: id, kind: item.kind, subject: item.subject, startedAt: item.row.started_at,
        finishedAt: item.row.finished_at, total: item.row.total, correct: item.row.correct,
        activeMinutes: roundMinutes(milliseconds.get(id) ?? 0),
        ...(bossOutcome === undefined ? {} : { bossOutcome }),
      };
    });
}

function readIntegrityReviews(
  db: Database,
  since: string,
  until: string,
): ParentsIntegrityReview[] {
  const rows = db.prepare<[string, string], {
    run_id: number;
    kind: string;
    subject: string;
    started_at: string;
    status: ParentsIntegrityReview['status'];
    flagged: number;
    retry_required: number;
  }>(
    `SELECT integrity_reviews.run_id, runs.kind, runs.subject, runs.started_at,
            integrity_reviews.status, COUNT(integrity_items.id) AS flagged,
            SUM(CASE WHEN integrity_items.status = 'retry_required' THEN 1 ELSE 0 END) AS retry_required
       FROM integrity_reviews JOIN runs ON runs.id = integrity_reviews.run_id
       JOIN integrity_items ON integrity_items.run_id = integrity_reviews.run_id
      WHERE runs.finished_at IS NULL AND runs.started_at >= ? AND runs.started_at <= ?
      GROUP BY integrity_reviews.run_id
      ORDER BY runs.started_at DESC, integrity_reviews.run_id DESC`,
  ).all(since, until);
  return rows.map((row) => {
    const subject = subjectOf(row.subject, `integrity_reviews.run_id=${row.run_id}`);
    if (row.kind !== 'run' && row.kind !== 'lesson') {
      throw new Error(`Дашборд родителей: проверка привязана к занятию вида «${row.kind}»`);
    }
    requireDate(row.started_at, `runs.started_at id=${row.run_id}`);
    return {
      runId: row.run_id,
      kind: row.kind,
      subject,
      startedAt: row.started_at,
      status: row.status,
      flagged: row.flagged,
      retryRequired: row.retry_required,
    };
  });
}

function parseChoices(value: string | null, taskId: number): string[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Дашборд родителей: choices задания ${taskId} не является JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((choice) => typeof choice !== 'string')) {
    throw new Error(`Дашборд родителей: choices задания ${taskId} не является массивом строк`);
  }
  return parsed as string[];
}

/**
 * Возвращает полную последовательность ответов одного занятия из текущего
 * семисуточного окна. Повторные ответы остаются отдельными строками: только так
 * родитель видит не итоговую маску, а реальный ход исправления.
 */
export function readParentsRunDetail(
  db: Database,
  graph: TopicGraph,
  runId: number,
  now: Date,
): ParentsRunDetail | null {
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Дашборд родителей: некорректное now (${String(now)})`);
  }
  const until = now.toISOString();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const row = db.prepare<[number, string, string, string, string], RunDetailRow>(
    `SELECT runs.id, runs.subject, runs.kind, runs.started_at, runs.finished_at,
            runs.summary, runs.total, runs.correct, integrity_reviews.status AS integrity_status
       FROM runs LEFT JOIN integrity_reviews ON integrity_reviews.run_id = runs.id
      WHERE runs.id = ? AND (
        (runs.finished_at IS NOT NULL AND runs.finished_at >= ? AND runs.finished_at <= ?
          AND (runs.kind = 'boss' OR runs.summary IS NOT NULL))
        OR (integrity_reviews.run_id IS NOT NULL AND runs.started_at >= ? AND runs.started_at <= ?)
      )`,
  ).get(runId, since, until, since, until);
  if (row === undefined) return null;

  const subject = subjectOf(row.subject, `runs.id=${row.id}`);
  const kind = kindOf(row.kind);
  const startedAt = requireDate(row.started_at, `runs.started_at id=${row.id}`);
  const finishedAt = row.finished_at === null
    ? null
    : requireDate(row.finished_at, `runs.finished_at id=${row.id}`);
  if ((finishedAt !== null && finishedAt < startedAt) || row.total < 0 || row.correct < 0 || row.correct > row.total) {
    throw new Error(`Дашборд родителей: повреждённый завершённый run ${row.id}`);
  }

  const rows = db.prepare<[number], AttemptDetailRow>(
    `SELECT attempts.id, attempts.task_id, attempts.run_id, attempts.topic_id,
            attempts.answer, attempts.is_correct, attempts.hint_used,
            attempts.duration_ms, attempts.created_at, attempts.is_current,
            task_bank.question, task_bank.instruction, task_bank.material,
            task_bank.material_format, task_bank.choices,
            task_bank.answer AS correct_answer, task_bank.hint, task_bank.explain
       FROM attempts JOIN task_bank ON task_bank.id = attempts.task_id
      WHERE attempts.run_id = ? ORDER BY attempts.created_at, attempts.id`,
  ).all(runId);
  validateAttempts(rows, graph);

  const integrityByAttempt = new Map(db.prepare<[number], IntegrityDetailRow>(
    `SELECT id, attempt_id, status, decision, confidence, reason, reviewed_by
       FROM integrity_items WHERE run_id = ? ORDER BY id`,
  ).all(runId).map((item) => [item.attempt_id, item]));

  const seenTasks = new Set<number>();
  let activeMilliseconds = 0;
  const attempts = rows.map((attempt, index): ParentsRunAttempt => {
    const topic = graph.byId.get(attempt.topic_id);
    if (topic === undefined) {
      throw new Error(`Дашборд родителей: попытка с неизвестной темой (${attempt.topic_id})`);
    }
    if (attempt.is_correct !== 0 && attempt.is_correct !== 1) {
      throw new Error(`Дашборд родителей: повреждён результат попытки ${attempt.id}`);
    }
    if (attempt.hint_used !== 0 && attempt.hint_used !== 1) {
      throw new Error(`Дашборд родителей: повреждена подсказка попытки ${attempt.id}`);
    }
    if (attempt.material_format !== null &&
        attempt.material_format !== 'none' &&
        attempt.material_format !== 'text' &&
        attempt.material_format !== 'math') {
      throw new Error(`Дашборд родителей: повреждён формат материала задания ${attempt.task_id}`);
    }
    activeMilliseconds += attempt.duration_ms;
    const correction = seenTasks.has(attempt.task_id);
    seenTasks.add(attempt.task_id);
    return {
      number: index + 1,
      topicTitle: topic.title,
      answerFormat: topic.answerFormat,
      question: attempt.question,
      ...(attempt.instruction === null ? {} : { instruction: attempt.instruction }),
      ...(attempt.material === null ? {} : { material: attempt.material }),
      ...(attempt.material_format === null
        ? {}
        : { materialFormat: attempt.material_format }),
      choices: parseChoices(attempt.choices, attempt.task_id),
      studentAnswer: attempt.answer,
      correctAnswer: attempt.correct_answer,
      explanation: attempt.explain ?? '',
      ...(attempt.hint_used === 1 && attempt.hint !== null ? { hint: attempt.hint } : {}),
      correct: attempt.is_correct === 1,
      correction,
      durationMilliseconds: attempt.duration_ms,
      answeredAt: attempt.created_at,
      current: attempt.is_current === 1,
      ...(integrityByAttempt.get(attempt.id) === undefined ? {} : {
        integrity: (() => {
          const item = integrityByAttempt.get(attempt.id) as IntegrityDetailRow;
          return {
            itemId: item.id,
            status: item.status,
            ...(item.decision === null ? {} : { decision: item.decision }),
            ...(item.confidence === null ? {} : { confidence: item.confidence }),
            ...(item.reason === null ? {} : { reason: item.reason }),
            ...(item.reviewed_by === null ? {} : { reviewedBy: item.reviewed_by }),
          };
        })(),
      }),
    };
  });

  return {
    runId: row.id,
    kind,
    subject,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    total: row.total,
    correct: row.correct,
    activeMilliseconds,
    attempts,
    ...(row.integrity_status === null ? {} : { integrityStatus: row.integrity_status }),
  };
}

function missedThreeFullDays(runs: RunRow[], now: Date): boolean {
  const completedDays = new Set(runs.filter((run) => run.kind === 'run' && run.summary !== null)
    .map((run) => moscowDay(new Date(run.finished_at))));
  const today = moscowDay(now);
  return Array.from({ length: STALE_RUN_DAYS }, (_, index) => previousDay(today, index + 1))
    .every((day) => !completedDays.has(day));
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
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const { rows: runs, byId: runById } = readRuns(db, since, until);
  const attempts = readWindowAttempts(db, graph, since, until);
  const states = readTopicStates(db);
  const forecast = buildForecasts(
    graph, states, readSnapshots(db, since, until), runs, now, since, until,
  );
  return {
    generatedAt: until,
    computerAccess: readDailyGate(db, now),
    window: { since, until },
    forecasts: forecast.forecasts,
    time: buildTime(attempts),
    gaps: buildGaps(graph, states, now),
    activity: readActivity(db, graph, runById, since, until),
    integrityReviews: readIntegrityReviews(db, since, until),
    flags: {
      threeFullDaysWithoutRun: missedThreeFullDays(runs, now),
      forecastNotGrowing: forecast.forecastNotGrowing,
      reduceLoad: forecast.reduceLoad,
    },
  };
}
