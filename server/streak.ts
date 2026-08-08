import type { Database } from 'better-sqlite3';

const MOSCOW_TIME_ZONE = 'Europe/Moscow';

const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface FinishedRunRow {
  finished_at: string;
}

export interface Streak {
  current: number;
  best: number;
  completedToday: boolean;
}

function moscowDate(value: Date): string {
  const parts = moscowDateFormatter.formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Не удалось определить московскую календарную дату');
  }
  return `${year}-${month}-${day}`;
}

function dayNumber(date: string): number {
  const [yearText, monthText, dayText] = date.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function completedDays(db: Database, now: Date): number[] {
  const rows = db
    .prepare<[string], FinishedRunRow>(
      `SELECT finished_at
         FROM runs
        WHERE kind = 'run' AND summary IS NOT NULL
          AND finished_at IS NOT NULL AND finished_at <> ''
          AND finished_at <= ?`,
    )
    .all(now.toISOString());

  return [...new Set(rows.map((row) => dayNumber(moscowDate(new Date(row.finished_at)))))]
    .sort((left, right) => left - right);
}

/** Считает серии по завершённым обычным забегам и московским календарным дням. */
export function readStreak(db: Database, now: Date = new Date()): Streak {
  const days = completedDays(db, now);
  if (days.length === 0) return { current: 0, best: 0, completedToday: false };

  let best = 1;
  let consecutive = 1;
  for (let index = 1; index < days.length; index += 1) {
    consecutive = days[index] === (days[index - 1] ?? 0) + 1 ? consecutive + 1 : 1;
    best = Math.max(best, consecutive);
  }

  const today = dayNumber(moscowDate(now));
  const completed = new Set(days);
  const completedToday = completed.has(today);
  const currentEnd = completedToday ? today : today - 1;
  let current = 0;
  while (completed.has(currentEnd - current)) current += 1;

  return { current, best, completedToday };
}
