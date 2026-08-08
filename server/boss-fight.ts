import type { Database } from 'better-sqlite3';
import { BOSS_TARGET } from './boss-rules.js';

export interface BossFight {
  batchId: number;
  batchTopicId: string;
  batchStatus: string;
  batchRunId: number | null;
  runId: number;
  runTopicId: string;
  subject: string;
  kind: string;
  finishedAt: string | null;
  total: number;
  correct: number;
  attemptTotal: number;
  attemptCorrect: number;
  wrong: number;
  openDisputes: number;
  position: number | null;
  lastAttemptId: number | null;
}

/** Единый снимок идентичности и прогресса boss batch/run. */
export function readBossFight(db: Database, runId: number, taskId?: number): BossFight | undefined {
  const row = db.prepare<
    [number | null, number],
    {
      batch_id: number | null; batch_topic_id: string | null; batch_status: string | null;
      batch_run_id: number | null; run_id: number; run_topic_id: string; subject: string;
      kind: string; finished_at: string | null; total: number; correct: number;
      attempt_total: number; attempt_correct: number; wrong: number; open_disputes: number;
      position: number | null; last_attempt_id: number | null;
    }
  >(
    `SELECT boss_batches.id AS batch_id, boss_batches.topic_id AS batch_topic_id,
            boss_batches.status AS batch_status, boss_batches.run_id AS batch_run_id,
            runs.id AS run_id, runs.topic_id AS run_topic_id, runs.subject, runs.kind,
            runs.finished_at, runs.total, runs.correct, boss_tasks.position,
            COUNT(DISTINCT attempts.id) AS attempt_total,
            COALESCE(SUM(attempts.is_correct), 0) AS attempt_correct,
            COALESCE(SUM(CASE WHEN attempts.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong,
            COUNT(DISTINCT CASE WHEN disputes.status = 'open' THEN disputes.id END) AS open_disputes,
            MAX(attempts.id) AS last_attempt_id
       FROM runs
       LEFT JOIN boss_batches ON boss_batches.run_id = runs.id
       LEFT JOIN boss_tasks ON boss_tasks.batch_id = boss_batches.id AND boss_tasks.task_id = ?
       LEFT JOIN attempts ON attempts.run_id = runs.id
       LEFT JOIN disputes ON disputes.attempt_id = attempts.id
      WHERE runs.id = ?
      GROUP BY runs.id, boss_batches.id, boss_tasks.position`,
  ).get(taskId ?? null, runId);
  if (row === undefined || row.batch_id === null || row.batch_topic_id === null || row.batch_status === null) {
    return undefined;
  }
  return {
    batchId: row.batch_id, batchTopicId: row.batch_topic_id, batchStatus: row.batch_status,
    batchRunId: row.batch_run_id, runId: row.run_id, runTopicId: row.run_topic_id,
    subject: row.subject, kind: row.kind, finishedAt: row.finished_at, total: row.total,
    correct: row.correct, attemptTotal: row.attempt_total, attemptCorrect: row.attempt_correct,
    wrong: row.wrong, openDisputes: row.open_disputes, position: row.position,
    lastAttemptId: row.last_attempt_id,
  };
}

export function bossFightConsistent(
  fight: BossFight,
  expected?: { id: string; subject: string },
): boolean {
  return fight.kind === 'boss' && fight.batchRunId === fight.runId &&
    fight.batchTopicId === fight.runTopicId && fight.total === fight.attemptTotal &&
    fight.correct === fight.attemptCorrect && fight.total >= 0 && fight.correct >= 0 &&
    fight.correct <= fight.total &&
    (expected === undefined || (fight.runTopicId === expected.id && fight.subject === expected.subject));
}

/** Атомарный переход 5/5, общий для прямого ответа и upheld-спора. */
export function finishBossWin(db: Database, fight: BossFight, finishedAt: string): void {
  const run = db.prepare(
    "UPDATE runs SET finished_at = ? WHERE id = ? AND kind = 'boss' AND finished_at IS NULL AND total = ? AND correct = ?",
  ).run(finishedAt, fight.runId, BOSS_TARGET, BOSS_TARGET);
  const batch = db.prepare(
    `UPDATE boss_batches SET status = 'won', finished_at = ?
      WHERE id = ? AND run_id = ? AND status = 'active'`,
  ).run(finishedAt, fight.batchId, fight.runId);
  const topic = db.prepare(
    'UPDATE topic_state SET closed_at = COALESCE(closed_at, ?) WHERE topic_id = ?',
  ).run(finishedAt, fight.runTopicId);
  if (run.changes !== 1 || batch.changes !== 1 || topic.changes !== 1) {
    throw new Error(`Босс: победа в бою ${fight.runId} не записалась целиком`);
  }
}
