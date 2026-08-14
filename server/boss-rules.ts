/** Чистые калибровочные правила боя, доступные общему пути ответа без циклических импортов. */

/** Босс появляется только выше этого значения, равенства недостаточно. */
export const BOSS_MASTERY = 0.75;
/** Победа требует пяти верных ответов подряд. */
export const BOSS_TARGET = 5;

/** Пользовательский прогресс до босса без раскрытия внутреннего значения mastery. */
export function bossProgress(mastery: number): number {
  if (!Number.isFinite(mastery) || mastery < 0 || mastery > 1) {
    throw new Error(`Босс: mastery вне 0..1 (${mastery})`);
  }
  if (mastery > BOSS_MASTERY) return 100;
  return Math.min(99, Math.round((mastery / BOSS_MASTERY) * 100));
}
