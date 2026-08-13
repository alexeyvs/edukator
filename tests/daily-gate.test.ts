import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { DAILY_RUN_TARGET, readDailyGate } from '../server/daily-gate.js';
import { openDatabase } from '../server/db.js';

const databases: Database[] = [];
const tempDirs: string[] = [];

function setup(): Database {
  const tempDir = mkdtempSync(join(tmpdir(), 'edukator-daily-gate-'));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, 'daily-gate.db'));
  databases.push(db);
  db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.fractions');
  return db;
}

function addRun(
  db: Database,
  kind: 'run' | 'triage' | 'boss' | 'lesson',
  finishedAt: string | null,
  summary: string | null = '{}',
): void {
  db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES ('math', ?, 'math.fractions', ?, ?, ?)`,
  ).run(kind, finishedAt ?? '2026-08-08T12:00:00.000Z', finishedAt, summary);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
});

describe('readDailyGate', () => {
  it('держит норму дня из трёх обычных забегов', () => {
    expect(DAILY_RUN_TARGET).toBe(3);
    expect(readDailyGate(setup(), new Date('2026-08-08T12:00:00.000Z'))).toEqual({
      day: '2026-08-08', required: 3, completed: 0, remaining: 3, unlocked: false,
    });
  });

  it('разблокирует после третьего результата и не даёт remaining уйти ниже нуля', () => {
    const db = setup();
    for (let index = 0; index < 4; index += 1) {
      addRun(db, 'run', `2026-08-08T0${index + 7}:00:00.000Z`);
    }

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 4, remaining: 0, unlocked: true,
    });
  });

  it('не считает другие виды, незавершённые строки и результат без summary', () => {
    const db = setup();
    addRun(db, 'triage', '2026-08-08T08:00:00.000Z');
    addRun(db, 'boss', '2026-08-08T09:00:00.000Z');
    addRun(db, 'lesson', '2026-08-08T10:00:00.000Z');
    addRun(db, 'run', null, null);
    addRun(db, 'run', '2026-08-08T11:00:00.000Z', null);

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 0, remaining: 3, unlocked: false,
    });
  });

  it('использует границу московской полуночи по finished_at', () => {
    const db = setup();
    addRun(db, 'run', '2026-08-07T20:59:59.999Z');
    addRun(db, 'run', '2026-08-07T21:00:00.000Z');
    addRun(db, 'run', '2026-08-08T20:59:59.999Z');
    addRun(db, 'run', '2026-08-08T21:00:00.000Z');

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      day: '2026-08-08', completed: 2, remaining: 1, unlocked: false,
    });
  });
});
