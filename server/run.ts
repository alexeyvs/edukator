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
import { rankTopics, selectTopic, topicsUsedToday } from './scheduler.js';
import { SessionError } from './session-error.js';
import { taskXp } from './xp.js';
import { TRIAGE_TARGET } from './triage.js';
import { moscowDayBounds } from './moscow-time.js';
import { LEARNING_TASK_COUNT } from './learning-constants.js';

/** Число ответов, после которого забег готов к финальному экрану. */
export const RUN_TARGET = 12;
export const RUN_LIVES = 3;

export type RunKind = 'run' | 'triage' | 'boss' | 'lesson';

/** Проверяет строковое значение из SQLite до передачи в доменную логику. */
export function isRunKind(value: string): value is RunKind {
  return value === 'run' || value === 'triage' || value === 'boss' || value === 'lesson';
}

export interface RunProgress {
  total: number;
  correct: number;
  target: number;
  done: boolean;
  lives?: {
    total: 3;
    remaining: number;
    retryAvailable: boolean;
  };
}

export interface StartRunOptions {
  now?: Date;
  kind?: Exclude<RunKind, 'boss' | 'lesson'>;
  /** Тема конкретной карточки плана; для триажа тему выбирает его собственная политика. */
  topicId?: string;
}

export interface StartRunResult {
  runId: number;
  resumed: boolean;
  progress: RunProgress;
}

export interface FinishRunOptions {
  now?: Date;
  /** Lesson закрывает только learning-домен после проверки полного комплекта. */
  allowLesson?: boolean;
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
  /** Все затронутые темы; финал триажа ранжирует их независимо от порогов. */
  touchedTopics: RunTopicChange[];
  forecast: ForecastSnapshot;
  /** Нет у первого снимка: отсутствие истории не равно нулевому сдвигу. */
  forecastDelta?: number;
}

interface RunCounters {
  total: number;
  correct: number;
  kind: RunKind;
  lives_remaining: number | null;
  retry_task_id: number | null;
}

interface FinishableRun {
  id: number;
  subject: Subject;
  kind: RunKind;
  finished_at: string | null;
  summary: string | null;
}

interface RunAttemptRow {
  id: number;
  topic_id: string;
  run_id: number | null;
  is_correct: number;
  hint_used: number;
  difficulty: number;
  created_at: string;
  affects_progress: number;
}

function progressFrom(row: RunCounters): RunProgress {
  const target = row.kind === 'lesson' ? LEARNING_TASK_COUNT : RUN_TARGET;
  const progress: RunProgress = {
    total: row.total,
    correct: row.correct,
    target,
    done: row.total >= target && row.retry_task_id === null,
  };
  if (row.kind === 'run') {
    if (row.lives_remaining === null) {
      throw new Error('Обычный забег не хранит число оставшихся жизней');
    }
    progress.lives = {
      total: RUN_LIVES,
      remaining: row.lives_remaining,
      retryAvailable: row.retry_task_id !== null,
    };
  }
  return progress;
}

function readRunProgress(db: Database, runId: number): RunProgress {
  const row = db
    .prepare<[number], RunCounters>(
      'SELECT total, correct, kind, lives_remaining, retry_task_id FROM runs WHERE id = ?',
    )
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
    const [start, next] = moscowDayBounds(now);

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
        WHERE finished_at IS NULL AND kind IN ('run', 'triage') AND started_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM attempts
            JOIN disputes ON disputes.attempt_id = attempts.id
            WHERE attempts.run_id = runs.id AND disputes.status = 'open'
          )`,
    ).run(start);

    const active = db
      .prepare<[Subject, Exclude<RunKind, 'boss' | 'lesson'>, string, string], { id: number }>(
        `SELECT id FROM runs
          WHERE subject = ? AND kind = ? AND finished_at IS NULL
            AND EXISTS (
              SELECT 1 FROM topic_state
               WHERE topic_state.topic_id = runs.topic_id AND topic_state.closed_at IS NULL
            )
            AND started_at >= ? AND started_at < ?
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(subject, kind, start, next);
    if (active !== undefined) {
      return { runId: active.id, resumed: true, progress: readRunProgress(db, active.id) };
    }

    const used = topicsUsedToday(db, now);
    const states = readTopicStates(db);
    const examDate = readProfile(db).examDate;
    const requestedTopicOpen = options.topicId === undefined || db.prepare<
      [string], { open: number }
    >('SELECT 1 AS open FROM topic_state WHERE topic_id = ? AND closed_at IS NULL')
      .get(options.topicId) !== undefined;
    const chosen = options.topicId === undefined
      ? selectTopic(graph, states, subject, { now, examDate, used }, used)
      : rankTopics(graph, states, { now, examDate }, subject).find((item) =>
          requestedTopicOpen && item.topic.id === options.topicId &&
          item.priority > 0 && !used.has(item.topic.id),
        ) ?? null;
    if (chosen === null) {
      throw new SessionError(
        'run-topic-unavailable',
        options.topicId === undefined
          ? `Забег: для предмета «${subject}» нет доступной темы`
          : `Забег: тема «${options.topicId}» больше недоступна в плане`,
      );
    }

    const runId = Number(
      db.prepare(
        `INSERT INTO runs (subject, kind, topic_id, started_at, lives_remaining)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        subject,
        kind,
        chosen.topic.id,
        now.toISOString(),
        kind === 'run' ? RUN_LIVES : null,
      ).lastInsertRowid,
    );

    return { runId, resumed: false, progress: readRunProgress(db, runId) };
  }).immediate();
}

function topicChanges(
  db: Database,
  graph: TopicGraph,
  runId: number,
): {
  touchedTopics: RunTopicChange[];
  closedTopics: RunTopicChange[];
  declinedTopics: RunTopicChange[];
} {
  const touched = db
    .prepare<[number], { topic_id: string }>(
      `SELECT DISTINCT topic_id FROM attempts
        WHERE run_id = ? AND is_current = 1 AND affects_progress = 1 ORDER BY topic_id`,
    )
    .all(runId)
    .map((row) => row.topic_id);
  if (touched.length === 0) {
    return { touchedTopics: [], closedTopics: [], declinedTopics: [] };
  }

  const placeholders = touched.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], RunAttemptRow>(
      `SELECT attempts.id, attempts.topic_id, attempts.run_id, attempts.is_correct,
              attempts.hint_used, task_bank.difficulty, attempts.created_at,
              attempts.affects_progress
         FROM attempts
         JOIN task_bank ON task_bank.id = attempts.task_id
        WHERE attempts.topic_id IN (${placeholders}) AND attempts.is_current = 1
          AND attempts.affects_progress = 1
        ORDER BY attempts.created_at, attempts.id`,
    )
    .all(...touched);

  const byTopic = new Map<string, RunAttemptRow[]>();
  for (const row of rows) {
    const history = byTopic.get(row.topic_id) ?? [];
    history.push(row);
    byTopic.set(row.topic_id, history);
  }

  const touchedTopics: RunTopicChange[] = [];
  const closedTopics: RunTopicChange[] = [];
  const declinedTopics: RunTopicChange[] = [];
  for (const topicId of touched) {
    const topic = graph.byId.get(topicId);
    if (topic === undefined) {
      throw new Error(`Забег: темы «${topicId}» нет в карте`);
    }

    let state = newTopicState(topicId);
    let before: number | undefined;
    const history = byTopic.get(topicId) ?? [];
    const lastRunAttempt = history.findLast((row) => row.run_id === runId);
    for (const row of history) {
      if (row.run_id === runId && before === undefined) before = state.mastery;
      state = applyAttempt(state, {
        correct: row.is_correct === 1,
        difficulty: row.difficulty,
        hintUsed: row.hint_used === 1,
        at: new Date(row.created_at),
      });
      if (row.id === lastRunAttempt?.id) break;
    }
    if (before === undefined) continue;

    const change = { topicId, title: topic.title, before, after: state.mastery };
    touchedTopics.push(change);
    if (before < GAP_MASTERY && state.mastery >= GAP_MASTERY) closedTopics.push(change);
    if (state.mastery < before) declinedTopics.push(change);
  }

  return { touchedTopics, closedTopics, declinedTopics };
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
        'SELECT id, subject, kind, finished_at, summary FROM runs WHERE id = ?',
      )
      .get(runId);
    if (run === undefined) {
      throw new SessionError('run-not-found', `Забег ${runId} не найден`);
    }
    if (run.finished_at !== null) {
      if (run.summary !== null) {
        return JSON.parse(run.summary) as FinishRunResult;
      }
      throw new SessionError('run-finished', `Забег ${runId} уже завершён`);
    }
    if (run.kind === 'boss') {
      throw new SessionError(
        'run-not-ready',
        `Бой с боссом ${runId} завершается только победой или поражением`,
      );
    }
    if (run.kind === 'lesson' && options.allowLesson !== true) {
      throw new SessionError(
        'run-not-ready',
        `Lesson-run ${runId} завершается только через учебный материал`,
      );
    }

    const attempts = db
      .prepare<[number], RunAttemptRow>(
        `SELECT attempts.id, attempts.topic_id, attempts.run_id, attempts.is_correct,
                attempts.hint_used, task_bank.difficulty, attempts.created_at,
                attempts.affects_progress
           FROM attempts
           JOIN task_bank ON task_bank.id = attempts.task_id
          WHERE attempts.run_id = ? AND attempts.is_current = 1
          ORDER BY attempts.created_at, attempts.id`,
      )
      .all(runId);
    const total = attempts.length;
    if (run.kind === 'run' && total < RUN_TARGET) {
      throw new SessionError(
        'run-not-ready',
        `Забег ${runId} нельзя завершить раньше ${RUN_TARGET} ответов`,
      );
    }
    if (run.kind === 'run') {
      const retry = db.prepare<[number], { retry_task_id: number | null }>(
        'SELECT retry_task_id FROM runs WHERE id = ?',
      ).get(runId);
      if (retry?.retry_task_id !== null) {
        throw new SessionError(
          'run-not-ready',
          `Забег ${runId} нельзя завершить, пока доступно исправление ответа`,
        );
      }
    }
    if (run.kind === 'triage' && total < TRIAGE_TARGET) {
      const attempted = new Set(attempts.map((attempt) => attempt.topic_id));
      const hasAvailableTopic = (graph.bySubject.get(run.subject) ?? []).some((topic) => {
        if (attempted.has(topic.id)) return false;
        return db.prepare<{ topicId: string; runId: number }, { ok: number }>(
          `SELECT 1 AS ok FROM task_bank
            WHERE topic_id = @topicId
              AND (status = 'valid' OR (
                status = 'used' AND issued_run_id = @runId
                AND NOT EXISTS (
                  SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id
                )
              ))
            LIMIT 1`,
        ).get({ topicId: topic.id, runId }) !== undefined;
      });
      if (hasAvailableTopic) {
        throw new SessionError('run-not-ready', `Триаж ${runId} ещё не завершён`);
      }
    }
    const openDispute = db.prepare<[number], { id: number }>(
      `SELECT disputes.id FROM disputes
        JOIN attempts ON attempts.id = disputes.attempt_id
       WHERE attempts.run_id = ? AND disputes.status = 'open'
       LIMIT 1`,
    ).get(runId);
    if (openDispute !== undefined) {
      throw new SessionError(
        'run-not-ready',
        `Забег ${runId} нельзя завершить, пока разбирается спор`,
      );
    }
    const correct = attempts.reduce((sum, attempt) => sum + attempt.is_correct, 0);
    const xp = attempts.reduce(
      (sum, attempt) =>
        sum + (attempt.affects_progress === 1
          ? taskXp({
              difficulty: attempt.difficulty,
              correct: attempt.is_correct === 1,
              hintUsed: attempt.hint_used === 1,
            })
          : 0),
      0,
    );
    const changes = topicChanges(db, graph, runId);
    const previous = readSnapshots(db, run.subject).at(-1);
    const recordsForecast = run.kind !== 'lesson' ||
      attempts.some((attempt) => attempt.affects_progress === 1);
    const forecast = recordsForecast
      ? recordForecasts(db, graph, now).find((snapshot) => snapshot.subject === run.subject)
      : previous;
    if (forecast === undefined) {
      throw new Error(`Забег: для предмета «${run.subject}» прогноз не посчитан`);
    }

    const result: FinishRunResult = {
      runId,
      total,
      correct,
      xp,
      ...changes,
      forecast,
      ...(previous === undefined ? {} : { forecastDelta: forecast.score - previous.score }),
    };
    db.prepare('UPDATE runs SET finished_at = ?, summary = ? WHERE id = ?')
      .run(now.toISOString(), JSON.stringify(result), runId);
    return result;
  }).immediate();
}
