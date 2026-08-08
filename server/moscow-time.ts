/** Календарный пояс ученика: все продуктовые границы дня привязаны к Москве. */
export const MOSCOW_TIME_ZONE = 'Europe/Moscow';

const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Возвращает московскую календарную дату независимо от пояса процесса. */
export function moscowDate(value: Date): string {
  const parts = moscowDateFormatter.formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Не удалось определить московскую календарную дату');
  }
  return `${year}-${month}-${day}`;
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + 1))
    .toISOString().slice(0, 10);
}

function moscowMidnight(date: string): string {
  // Europe/Moscow с 2014 года постоянно живёт в UTC+03:00. Все времена
  // приложения относятся к современной учебной истории, поэтому явное
  // смещение одновременно воспроизводимо и не зависит от TZ процесса.
  return new Date(`${date}T00:00:00+03:00`).toISOString();
}

/** ISO-границы московских календарных суток, содержащих `now`. */
export function moscowDayBounds(now: Date): [string, string] {
  const date = moscowDate(now);
  return [moscowMidnight(date), moscowMidnight(nextDate(date))];
}
