import type { Database } from 'better-sqlite3';
import { readProfile, type Subject } from './db.js';
import type { TopicGraph } from './curriculum.js';
import { readTopicStates } from './mastery.js';
import { selectTopic, topicsUsedToday } from './scheduler.js';

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

interface RunCounters {
  total: number;
  correct: number;
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
