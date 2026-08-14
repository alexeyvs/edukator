import type { Database } from 'better-sqlite3';
import { moscowDayBounds } from './moscow-time.js';

export const COMPUTER_ACCESS_OVERRIDE_MODES = ['blocked', 'unlocked'] as const;
export type ComputerAccessOverrideMode = (typeof COMPUTER_ACCESS_OVERRIDE_MODES)[number];

export interface ComputerAccessOverride {
  mode: ComputerAccessOverrideMode;
  changedAt: string;
  expiresAt: string;
}

interface ComputerAccessOverrideRow {
  mode: ComputerAccessOverrideMode;
  changed_at: string;
  expires_at: string;
}

/** Истёкшая команда остаётся в базе для диагностики, но больше не влияет на доступ. */
export function readComputerAccessOverride(
  db: Database,
  now: Date = new Date(),
): ComputerAccessOverride | null {
  const row = db.prepare<[string], ComputerAccessOverrideRow>(
    `SELECT mode, changed_at, expires_at
       FROM computer_access_override
      WHERE id = 1 AND expires_at > ?`,
  ).get(now.toISOString());
  if (row === undefined) return null;
  return { mode: row.mode, changedAt: row.changed_at, expiresAt: row.expires_at };
}

/** Устанавливает команду до начала следующих московских суток одним снимком. */
export function setComputerAccessOverride(
  db: Database,
  mode: ComputerAccessOverrideMode,
  now: Date = new Date(),
): ComputerAccessOverride {
  const changedAt = now.toISOString();
  const expiresAt = moscowDayBounds(now)[1];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO computer_access_override (id, mode, changed_at, expires_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         mode = excluded.mode,
         changed_at = excluded.changed_at,
         expires_at = excluded.expires_at`,
    ).run(mode, changedAt, expiresAt);
  }).immediate();
  return { mode, changedAt, expiresAt };
}

/** Возвращает управление автоматике, не оставляя промежуточного состояния. */
export function clearComputerAccessOverride(db: Database): void {
  db.transaction(() => {
    db.prepare('DELETE FROM computer_access_override WHERE id = 1').run();
  }).immediate();
}
