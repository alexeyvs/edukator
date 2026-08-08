import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { readStreak } from '../server/streak.js';

const databases: Database[] = [];
const tempDirs: string[] = [];

function setup(): Database {
  const tempDir = mkdtempSync(join(tmpdir(), 'edukator-streak-'));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, 'streak.db'));
  databases.push(db);
  db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.fractions');
  return db;
}

function addRun(
  db: Database,
  finishedAt: string | null,
  kind: 'run' | 'triage' | 'boss' = 'run',
): void {
  db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at)
     VALUES ('math', ?, 'math.fractions', ?, ?)`,
  ).run(kind, finishedAt ?? '2026-08-01T00:00:00.000Z', finishedAt);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
});

describe('readStreak', () => {
  it('возвращает нули для пустой истории', () => {
    expect(readStreak(setup(), new Date('2026-08-08T09:00:00.000Z'))).toEqual({
      current: 0,
      best: 0,
      completedToday: false,
    });
  });

  it('схлопывает несколько забегов одного дня', () => {
    const db = setup();
    addRun(db, '2026-08-07T08:00:00.000Z');
    addRun(db, '2026-08-07T19:00:00.000Z');
    addRun(db, '2026-08-08T08:00:00.000Z');

    expect(readStreak(db, new Date('2026-08-08T12:00:00.000Z'))).toEqual({
      current: 2,
      best: 2,
      completedToday: true,
    });
  });

  it('обнуляет current после пропущенного полного дня', () => {
    const db = setup();
    addRun(db, '2026-08-05T12:00:00.000Z');
    addRun(db, '2026-08-06T12:00:00.000Z');

    expect(readStreak(db, new Date('2026-08-08T12:00:00.000Z'))).toEqual({
      current: 0,
      best: 2,
      completedToday: false,
    });
  });

  it('сохраняет вчерашнюю серию до конца текущего дня', () => {
    const db = setup();
    addRun(db, '2026-08-05T12:00:00.000Z');
    addRun(db, '2026-08-06T12:00:00.000Z');
    addRun(db, '2026-08-07T12:00:00.000Z');

    expect(readStreak(db, new Date('2026-08-08T12:00:00.000Z'))).toEqual({
      current: 3,
      best: 3,
      completedToday: false,
    });
  });

  it('находит лучший исторический стрик отдельно от текущего', () => {
    const db = setup();
    for (const day of ['01', '02', '03', '04']) addRun(db, `2026-07-${day}T12:00:00.000Z`);
    addRun(db, '2026-08-07T12:00:00.000Z');
    addRun(db, '2026-08-08T12:00:00.000Z');

    expect(readStreak(db, new Date('2026-08-08T13:00:00.000Z'))).toEqual({
      current: 2,
      best: 4,
      completedToday: true,
    });
  });

  it('различает дни по границе московской полуночи', () => {
    const db = setup();
    addRun(db, '2026-08-07T20:59:59.999Z');
    addRun(db, '2026-08-07T21:00:00.000Z');

    expect(readStreak(db, new Date('2026-08-07T22:00:00.000Z'))).toEqual({
      current: 2,
      best: 2,
      completedToday: true,
    });
  });

  it('не зависит от UTC-даты во время московского перехода суток', () => {
    const db = setup();
    addRun(db, '2026-08-07T22:30:00.000Z');

    expect(readStreak(db, new Date('2026-08-07T23:30:00.000Z'))).toEqual({
      current: 1,
      best: 1,
      completedToday: true,
    });
  });

  it('не учитывает незавершённые, triage и boss', () => {
    const db = setup();
    addRun(db, '2026-08-06T12:00:00.000Z');
    addRun(db, null);
    addRun(db, '2026-08-07T12:00:00.000Z', 'triage');
    addRun(db, '2026-08-08T12:00:00.000Z', 'boss');

    expect(readStreak(db, new Date('2026-08-08T13:00:00.000Z'))).toEqual({
      current: 0,
      best: 1,
      completedToday: false,
    });
  });
});
