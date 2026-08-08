import type { Database } from 'better-sqlite3';
import { readProfile, type Subject } from './db.js';
import type { TopicGraph } from './curriculum.js';
import {
  applyAttempt,
  GAP_MASTERY,
  newTopicState,
  readTopicStates,
} from './mastery.js';
import {
  readSnapshots,
  recordForecasts,
  type ForecastSnapshot,
} from './forecast.js';
import { selectTopic, topicsUsedToday } from './scheduler.js';
import { SessionError } from './session-error.js';
import { taskXp } from './xp.js';

/** Число ответов, после которого забег готов к финальному экрану. */
export const RUN_TARGET = 12;

export type RunKind = 'run' | 'triage';

export interface RunProgress {
  total: number;
  correct: number;
  target: number;
  done: boolean;
}

export interface StartRunOptions {
  now?: Date;
  kind?: RunKind;
}

export interface StartRunResult {
  runId: number;
  resumed: boolean;
  progress: RunProgress;
}

export interface FinishRunOptions {
  now?: Date;
}

export interface RunTopicChange {
  topicId: string;
  title: string;
  before: number;
  after: number;
}

export interface FinishRunResult {
  runId: number;
  total: number;
  correct: number;
  xp: number;
  closedTopics: RunTopicChange[];
  declinedTopics: RunTopicChange[];
  forecast: ForecastSnapshot;
  /** Нет у первого снимка: отсутствие истории не равно нулевому сдвигу. */
  forecastDelta?: number;
}

interface RunCounters {
  total: number;
  correct: number;
}

interface FinishableRun {
  id: number;
  subject: Subject;
  finished_at: string | null;
}

interface RunAttemptRow {
  id: number;
  topic_id: string;
  run_id: number | null;
  is_correct: number;
  hint_used: number;
  difficulty: number;
  created_at: string;
}

function dayBounds(now: Date): [string, string] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return [start.toISOString(), next.toISOString()];
}

function progressFrom(row: RunCounters): RunProgress {
  return {
    total: row.total,
    correct: row.correct,
    target: RUN_TARGET,
    done: row.total >= RUN_TARGET,
  };
}

function readRunProgress(db: Database, runId: number): RunProgress {
  const row = db
    .prepare<[number], RunCounters>('SELECT total, correct FROM runs WHERE id = ?')
    .get(runId);
  if (row === undefined) throw new Error(`Забег ${runId} не найден`);
  return progressFrom(row);
}

/** Возвращает сохранённые сервером счётчики забега и его готовность к закрытию. */
export function runProgress(db: Database, runId: number): RunProgress {
  if (db.inTransaction) return readRunProgress(db, runId);
  return db.transaction(() => readRunProgress(db, runId)).immediate();
}

/**
 * Начинает забег либо восстанавливает сегодняшний незакрытый забег того же вида
 * и предмета. Закрытие вчерашних строк входит в ту же запись: два одновременных
 * старта не смогут оба прочитать отсутствие забега и завести по своей строке.
 */
export function startRun(
  db: Database,
  graph: TopicGraph,
  subject: Subject,
  options: StartRunOptions = {},
): StartRunResult {
  const now = options.now ?? new Date();
  const kind = options.kind ?? 'run';

  return db.transaction((): StartRunResult => {
    const [start, next] = dayBounds(now);

    if ((graph.bySubject.get(subject) ?? []).length === 0) {
      throw new Error(`Забег: предмет «${subject}» отсутствует в карте тем`);
    }

    // Брошенный забег заканчивается последним фактическим действием ученика, а
    // не временем следующего запуска. Без попыток точнее времени старта нет.
    db.prepare(
      `UPDATE runs
          SET finished_at = COALESCE(
            (SELECT MAX(attempts.created_at) FROM attempts WHERE attempts.run_id = runs.id),
            runs.started_at
          )
        WHERE finished_at IS NULL AND started_at < ?`,
    ).run(start);

    const active = db
      .prepare<[Subject, RunKind, string, string], { id: number }>(
        `SELECT id FROM runs
          WHERE subject = ? AND kind = ? AND finished_at IS NULL
            AND started_at >= ? AND started_at < ?
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(subject, kind, start, next);
    if (active !== undefined) {
      return { runId: active.id, resumed: true, progress: readRunProgress(db, active.id) };
    }

    const used = topicsUsedToday(db, now);
    const chosen = selectTopic(
      graph,
      readTopicStates(db),
      subject,
      { now, examDate: readProfile(db).examDate, used },
      used,
    );
    if (chosen === null) {
      throw new Error(`Забег: для предмета «${subject}» нет доступной темы`);
    }

    const runId = Number(
      db.prepare(
        'INSERT INTO runs (subject, kind, topic_id, started_at) VALUES (?, ?, ?, ?)',
      ).run(subject, kind, chosen.topic.id, now.toISOString()).lastInsertRowid,
    );

    return { runId, resumed: false, progress: readRunProgress(db, runId) };
  }).immediate();
}

function topicChanges(
  db: Database,
  graph: TopicGraph,
  runId: number,
): { closedTopics: RunTopicChange[]; declinedTopics: RunTopicChange[] } {
  const touched = db
    .prepare<[number], { topic_id: string }>(
      'SELECT DISTINCT topic_id FROM attempts WHERE run_id = ? ORDER BY topic_id',
    )
    .all(runId)
    .map((row) => row.topic_id);
  if (touched.length === 0) return { closedTopics: [], declinedTopics: [] };

  const placeholders = touched.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], RunAttemptRow>(
      `SELECT attempts.id, attempts.topic_id, attempts.run_id, attempts.is_correct,
              attempts.hint_used, task_bank.difficulty, attempts.created_at
         FROM attempts
         JOIN task_bank ON task_bank.id = attempts.task_id
        WHERE attempts.topic_id IN (${placeholders})
        ORDER BY attempts.created_at, attempts.id`,
    )
    .all(...touched);

  const byTopic = new Map<string, RunAttemptRow[]>();
  for (const row of rows) {
    const history = byTopic.get(row.topic_id) ?? [];
    history.push(row);
    byTopic.set(row.topic_id, history);
  }

  const closedTopics: RunTopicChange[] = [];
  const declinedTopics: RunTopicChange[] = [];
  for (const topicId of touched) {
    const topic = graph.byId.get(topicId);
    if (topic === undefined) {
      throw new Error(`Забег: темы «${topicId}» нет в карте`);
    }

    let state = newTopicState(topicId);
    let before: number | undefined;
    for (const row of byTopic.get(topicId) ?? []) {
      if (row.run_id === runId && before === undefined) before = state.mastery;
      state = applyAttempt(state, {
        correct: row.is_correct === 1,
        difficulty: row.difficulty,
        hintUsed: row.hint_used === 1,
        at: new Date(row.created_at),
      });
    }
    if (before === undefined) continue;

    const change = { topicId, title: topic.title, before, after: state.mastery };
    if (before < GAP_MASTERY && state.mastery >= GAP_MASTERY) closedTopics.push(change);
    if (state.mastery < before) declinedTopics.push(change);
  }

  return { closedTopics, declinedTopics };
}

/**
 * Закрывает забег и собирает итог по истории попыток. Строка забега, изменения
 * тем и снимки прогноза читаются и пишутся одним снимком базы: частичный итог
 * после сбоя не должен выглядеть завершённым забегом.
 */
export function finishRun(
  db: Database,
  graph: TopicGraph,
  runId: number,
  options: FinishRunOptions = {},
): FinishRunResult {
  const now = options.now ?? new Date();

  return db.transaction((): FinishRunResult => {
    const run = db
      .prepare<[number], FinishableRun>(
        'SELECT id, subject, finished_at FROM runs WHERE id = ?',
      )
      .get(runId);
    if (run === undefined) {
      throw new SessionError('run-not-found', `Забег ${runId} не найден`);
    }
    if (run.finished_at !== null) {
      throw new SessionError('run-finished', `Забег ${runId} уже завершён`);
    }

    const attempts = db
      .prepare<[number], RunAttemptRow>(
        `SELECT attempts.id, attempts.topic_id, attempts.run_id, attempts.is_correct,
                attempts.hint_used, task_bank.difficulty, attempts.created_at
           FROM attempts
           JOIN task_bank ON task_bank.id = attempts.task_id
          WHERE attempts.run_id = ?
          ORDER BY attempts.created_at, attempts.id`,
      )
      .all(runId);
    const total = attempts.length;
    const correct = attempts.reduce((sum, attempt) => sum + attempt.is_correct, 0);
    const xp = attempts.reduce(
      (sum, attempt) =>
        sum +
        taskXp({
          difficulty: attempt.difficulty,
          correct: attempt.is_correct === 1,
          hintUsed: attempt.hint_used === 1,
        }),
      0,
    );
    const changes = topicChanges(db, graph, runId);
    const previous = readSnapshots(db, run.subject).at(-1);

    db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(now.toISOString(), runId);
    const forecast = recordForecasts(db, graph, now).find(
      (snapshot) => snapshot.subject === run.subject,
    );
    if (forecast === undefined) {
      throw new Error(`Забег: для предмета «${run.subject}» прогноз не посчитан`);
    }

    return {
      runId,
      total,
      correct,
      xp,
      ...changes,
      forecast,
      ...(previous === undefined ? {} : { forecastDelta: forecast.score - previous.score }),
    };
  }).immediate();
}
