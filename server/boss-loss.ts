/** Атомарный исход поражения, общий для признания ошибки и отклонённого спора. */
import type { Database } from 'better-sqlite3';

export interface BossLossResult {
  runId: number;
  batchId: number;
  replacementBatchId: number;
}

interface BossLossRow {
  batch_id: number;
  topic_id: string;
  run_finished_at: string | null;
  batch_status: string;
}

/**
 * Проверяет, что живой батч появился после уже признанного поражения этой темы.
 * Такой батч — реванш: неверный ответ мог опустить mastery ниже исходного
 * порога, но повторный вход должен зависеть от свежести набора, а не от кулдауна.
 */
export function hasPriorBossLoss(db: Database, topicId: string, batchId?: number): boolean {
  if (batchId === undefined) {
    return db.prepare<[string], { found: number }>(
      "SELECT 1 AS found FROM boss_batches WHERE topic_id = ? AND status = 'lost' LIMIT 1",
    ).get(topicId) !== undefined;
  }
  return db.prepare<[string, number], { found: number }>(
    `SELECT 1 AS found FROM boss_batches
      WHERE topic_id = ? AND status = 'lost' AND id < ? LIMIT 1`,
  ).get(topicId, batchId) !== undefined;
}

/** Вызывается только внутри immediate-транзакции после доменной проверки боя. */
export function finishBossLoss(db: Database, runId: number, finishedAt: string): BossLossResult {
  const fight = db.prepare<[number], BossLossRow>(
    `SELECT boss_batches.id AS batch_id, boss_batches.topic_id,
            runs.finished_at AS run_finished_at, boss_batches.status AS batch_status
       FROM runs
       JOIN boss_batches ON boss_batches.run_id = runs.id
      WHERE runs.id = ? AND runs.kind = 'boss'`,
  ).get(runId);
  if (fight === undefined) {
    throw new Error(`Босс: активный бой ${runId} для поражения не найден`);
  }
  if (fight.run_finished_at !== null || fight.batch_status !== 'active') {
    throw new Error(`Босс: активный бой ${runId} для поражения не найден`);
  }

  db.prepare(
    "UPDATE runs SET finished_at = ? WHERE id = ? AND kind = 'boss' AND finished_at IS NULL",
  ).run(finishedAt, runId);
  db.prepare(
    `UPDATE boss_batches SET status = 'lost', finished_at = ?
      WHERE id = ? AND run_id = ? AND status = 'active'`,
  ).run(finishedAt, fight.batch_id, runId);
  const replacementBatchId = Number(db.prepare(
    "INSERT INTO boss_batches (topic_id, status, created_at) VALUES (?, 'preparing', ?)",
  ).run(fight.topic_id, finishedAt).lastInsertRowid);
  return { runId, batchId: fight.batch_id, replacementBatchId };
}
