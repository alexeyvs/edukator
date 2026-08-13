import type { Database } from 'better-sqlite3';
import { moscowDate, moscowDayBounds } from './moscow-time.js';

/** Число обычных забегов, после которого компьютер можно разблокировать. */
export const DAILY_RUN_TARGET = 3;

export interface DailyLearningGateState {
  materialId: number | null;
  required: boolean;
  passed: boolean;
}

export interface DailyGateState {
  day: string;
  required: number;
  completed: number;
  remaining: number;
  learning: DailyLearningGateState;
  unlocked: boolean;
}

interface DailyGateRow {
  completed: number;
  material_id: number | null;
  material_status: string | null;
}

interface DailyGateParams {
  dayStart: string;
  dayEnd: string;
  previousDayStart: string;
  now: string;
  targetOffset: number;
}

/**
 * Время третьего результата фиксирует состав обязательств на день: более
 * поздняя публикация не отбирает уже полученный доступ. Закрытые до начала дня
 * материалы не участвуют, а незачёт переносит тот же разбор дальше.
 */
export function readDailyGate(db: Database, now: Date = new Date()): DailyGateState {
  const [start, next] = moscowDayBounds(now);
  const [previousStart] = moscowDayBounds(new Date(Date.parse(start) - 1));
  const row = db.prepare<DailyGateParams, DailyGateRow>(
    `WITH current_day_runs AS (
       SELECT id, finished_at FROM runs
        WHERE kind = 'run' AND summary IS NOT NULL
          AND finished_at >= @dayStart AND finished_at < @dayEnd
     ), current_day_gate AS (
       SELECT COUNT(*) AS completed,
              (SELECT finished_at FROM current_day_runs
                ORDER BY finished_at, id LIMIT 1 OFFSET @targetOffset) AS third_finished_at
         FROM current_day_runs
     ), previous_day_runs AS (
       SELECT id, finished_at FROM runs
        WHERE kind = 'run' AND summary IS NOT NULL
          AND finished_at >= @previousDayStart AND finished_at < @dayStart
     ), previous_day_gate AS (
       SELECT (SELECT finished_at FROM previous_day_runs
                ORDER BY finished_at, id LIMIT 1 OFFSET @targetOffset) AS third_finished_at
     )
     SELECT current_day_gate.completed,
            learning_materials.id AS material_id,
            learning_materials.status AS material_status
       FROM current_day_gate, previous_day_gate
       LEFT JOIN learning_materials ON learning_materials.id = (
         SELECT id FROM learning_materials
          WHERE ready_at IS NOT NULL
            AND (
              (ready_at <= COALESCE(current_day_gate.third_finished_at, @now)
                AND (
                  status IN ('ready', 'active')
                  OR (status IN ('passed', 'retired') AND finished_at >= @dayStart)
                ))
              OR (
                status IN ('passed', 'retired')
                AND previous_day_gate.third_finished_at IS NOT NULL
                AND ready_at > previous_day_gate.third_finished_at
                AND ready_at >= @previousDayStart AND ready_at < @dayStart
              )
            )
          ORDER BY ready_at, id LIMIT 1
       )`,
  ).get({
    dayStart: start,
    dayEnd: next,
    previousDayStart: previousStart,
    now: now.toISOString(),
    targetOffset: DAILY_RUN_TARGET - 1,
  });
  const completed = row?.completed ?? 0;
  const remaining = Math.max(0, DAILY_RUN_TARGET - completed);
  const materialId = row?.material_id ?? null;
  const materialStatus = row?.material_status ?? null;
  const learning = {
    materialId,
    required: materialStatus === 'ready' || materialStatus === 'active' ||
      materialStatus === 'passed',
    passed: materialStatus === 'passed',
  };

  return {
    day: moscowDate(now),
    required: DAILY_RUN_TARGET,
    completed,
    remaining,
    learning,
    unlocked: completed >= DAILY_RUN_TARGET && (!learning.required || learning.passed),
  };
}
