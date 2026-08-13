import type { Database } from 'better-sqlite3';
import { moscowDate, moscowDayBounds } from './moscow-time.js';

/** Число обычных забегов, после которого компьютер можно разблокировать. */
export const DAILY_RUN_TARGET = 3;

export interface DailyGateState {
  day: string;
  required: number;
  completed: number;
  remaining: number;
  unlocked: boolean;
}

/**
 * Состояние доступа выводится только из зафиксированных итогов обычных забегов.
 * Время завершения определяет день: начатый до полуночи забег честно относится
 * к тем суткам, в которые ученик действительно дошёл до результата.
 */
export function readDailyGate(db: Database, now: Date = new Date()): DailyGateState {
  const [start, next] = moscowDayBounds(now);
  const row = db.prepare<[string, string], { completed: number }>(
    `SELECT COUNT(*) AS completed
       FROM runs
      WHERE kind = 'run' AND summary IS NOT NULL
        AND finished_at >= ? AND finished_at < ?`,
  ).get(start, next);
  const completed = row?.completed ?? 0;
  const remaining = Math.max(0, DAILY_RUN_TARGET - completed);

  return {
    day: moscowDate(now),
    required: DAILY_RUN_TARGET,
    completed,
    remaining,
    unlocked: completed >= DAILY_RUN_TARGET,
  };
}
