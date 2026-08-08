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

/** Вызывается только внутри immediate-транзакции после доменной проверки боя. */
export function finishBossLoss(db: Database, runId: number, finishedAt: string): BossLossResult {
  const fight = db.prepare<[number], BossLossRow>(
    `SELECT boss_batches.id AS batch_id, boss_batches.topic_id,
            runs.finished_at AS run_finished_at, boss_batches.status AS batch_status
       FROM runs
       JOIN boss_batches ON boss_batches.run_id = runs.id
      WHERE runs.id = ? AND runs.kind = 'boss'`,
  ).get(runId);
  if (fight === undefined || fight.run_finished_at !== null || fight.batch_status !== 'active') {
    throw new Error(`Босс: активный бой ${runId} для поражения не найден`);
  }

  const runChange = db.prepare(
    "UPDATE runs SET finished_at = ? WHERE id = ? AND kind = 'boss' AND finished_at IS NULL",
  ).run(finishedAt, runId);
  const batchChange = db.prepare(
    `UPDATE boss_batches SET status = 'lost', finished_at = ?
      WHERE id = ? AND run_id = ? AND status = 'active'`,
  ).run(finishedAt, fight.batch_id, runId);
  if (runChange.changes !== 1 || batchChange.changes !== 1) {
    throw new Error(`Босс: поражение в бою ${runId} не записалось целиком`);
  }

  const replacementBatchId = Number(db.prepare(
    "INSERT INTO boss_batches (topic_id, status, created_at) VALUES (?, 'preparing', ?)",
  ).run(fight.topic_id, finishedAt).lastInsertRowid);
  return { runId, batchId: fight.batch_id, replacementBatchId };
}
