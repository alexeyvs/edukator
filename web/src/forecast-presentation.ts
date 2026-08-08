/** При такой погрешности число больше похоже на стартовый ноль, чем на оценку ребёнка. */
export const PRELIMINARY_BAND = 0.75;

export function isPreliminaryForecast(forecast: { band: number }): boolean {
  return forecast.band >= PRELIMINARY_BAND;
}

export function runResultMessage(total: number, correct: number): string | null {
  if (total <= 0) return null;
  if (correct === total) return 'Все ответы верные — отличный забег.';
  if (correct > total / 2) return 'Больше половины уже получается — хороший старт.';
  return null;
}
