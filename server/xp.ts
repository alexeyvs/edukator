export const XP_BASE = 10;
export const XP_NO_HINT = 5;

export interface TaskXpInput {
  difficulty: number;
  correct: boolean;
  /** Сохранённый штраф старой попытки; для новых ответов false. */
  hintPenaltyApplied?: boolean;
  /** Совместимость со старыми прямыми вызовами. */
  hintUsed?: boolean;
}

export function taskXp(input: TaskXpInput): number {
  if (!Number.isInteger(input.difficulty) || input.difficulty < 1 || input.difficulty > 3) {
    throw new Error('Сложность задания должна быть целым числом от 1 до 3');
  }

  if (!input.correct) return 0;

  const penalized = input.hintPenaltyApplied ?? input.hintUsed ?? false;
  return XP_BASE * input.difficulty + (penalized ? 0 : XP_NO_HINT);
}
