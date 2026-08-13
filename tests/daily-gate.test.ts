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

function addMaterial(
  db: Database,
  readyAt: string,
  status: 'ready' | 'active' | 'passed' | 'failed' | 'retired' = 'ready',
  finishedAt: string | null = null,
): number {
  return Number(db.prepare(
    `INSERT INTO learning_materials
       (subject, topic_id, status, recommendation_reason, mastery_before,
        created_at, updated_at, ready_at, finished_at)
     VALUES ('math', 'math.fractions', ?, 'Нужен разбор', 0.2, ?, ?, ?, ?)`,
  ).run(status, readyAt, finishedAt ?? readyAt, readyAt, finishedAt).lastInsertRowid);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
});

describe('readDailyGate', () => {
  it('держит норму дня из трёх обычных забегов', () => {
    expect(DAILY_RUN_TARGET).toBe(3);
    expect(readDailyGate(setup(), new Date('2026-08-08T12:00:00.000Z'))).toEqual({
      day: '2026-08-08', required: 3, completed: 0, remaining: 3,
      learning: { materialId: null, required: false, passed: false }, unlocked: false,
    });
  });

  it('без материала разблокирует после третьего результата и не даёт remaining уйти ниже нуля', () => {
    const db = setup();
    for (let index = 0; index < 4; index += 1) {
      addRun(db, 'run', `2026-08-08T0${index + 7}:00:00.000Z`);
    }

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 4, remaining: 0,
      learning: { materialId: null, required: false, passed: false }, unlocked: true,
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

  it('выбирает первое предложение по ready_at, затем id, и не подменяет снятое следующим', () => {
    const db = setup();
    const firstAtTie = addMaterial(
      db, '2026-08-08T08:00:00.000Z', 'passed', '2026-08-08T10:00:00.000Z',
    );
    const retired = addMaterial(
      db, '2026-08-08T07:00:00.000Z', 'retired', '2026-08-08T09:00:00.000Z',
    );
    addMaterial(db, '2026-08-08T08:00:00.000Z', 'failed');

    const waived = readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'));
    expect(waived.learning).toEqual({ materialId: retired, required: false, passed: false });

    db.prepare('UPDATE learning_materials SET ready_at = ? WHERE id = ?')
      .run('2026-08-08T09:00:00.000Z', retired);
    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z')).learning)
      .toEqual({ materialId: firstAtTie, required: true, passed: true });
  });

  it('требует зачёт независимо от трёх забегов и принимает зачёт до третьего', () => {
    const db = setup();
    const materialId = addMaterial(
      db, '2026-08-08T06:00:00.000Z', 'passed', '2026-08-08T08:30:00.000Z',
    );
    addRun(db, 'run', '2026-08-08T07:00:00.000Z');
    addRun(db, 'run', '2026-08-08T08:00:00.000Z');

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 2,
      learning: { materialId, required: true, passed: true },
      unlocked: false,
    });

    addRun(db, 'run', '2026-08-08T09:00:00.000Z');
    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 3,
      learning: { materialId, required: true, passed: true },
      unlocked: true,
    });
  });

  it('не переблокирует публикацией после третьего забега, но требует её на следующие сутки', () => {
    const db = setup();
    addRun(db, 'run', '2026-08-08T07:00:00.000Z');
    addRun(db, 'run', '2026-08-08T08:00:00.000Z');
    addRun(db, 'run', '2026-08-08T09:00:00.000Z');
    const materialId = addMaterial(db, '2026-08-08T09:00:00.001Z');

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      learning: { materialId: null, required: false, passed: false },
      unlocked: true,
    });
    expect(readDailyGate(db, new Date('2026-08-08T21:00:00.000Z'))).toMatchObject({
      day: '2026-08-09', completed: 0,
      learning: { materialId, required: true, passed: false },
      unlocked: false,
    });

    db.prepare("UPDATE learning_materials SET status = 'failed', finished_at = ? WHERE id = ?")
      .run('2026-08-09T10:00:00.000Z', materialId);
    expect(readDailyGate(db, new Date('2026-08-09T21:00:00.000Z'))).toMatchObject({
      day: '2026-08-10',
      learning: { materialId, required: true, passed: false },
      unlocked: false,
    });
  });

  it('считает публикацию ровно в момент третьего забега и соблюдает московскую полночь', () => {
    const db = setup();
    addRun(db, 'run', '2026-08-08T18:00:00.000Z');
    addRun(db, 'run', '2026-08-08T19:00:00.000Z');
    addRun(db, 'run', '2026-08-08T20:59:59.999Z');
    const materialId = addMaterial(db, '2026-08-08T20:59:59.999Z');

    expect(readDailyGate(db, new Date('2026-08-08T20:59:59.999Z'))).toMatchObject({
      day: '2026-08-08', completed: 3,
      learning: { materialId, required: true, passed: false },
      unlocked: false,
    });
    expect(readDailyGate(db, new Date('2026-08-08T21:00:00.000Z'))).toMatchObject({
      day: '2026-08-09', completed: 0,
      learning: { materialId, required: true, passed: false },
      unlocked: false,
    });
  });

  it('не засчитывает активный материал с открытым спором', () => {
    const db = setup();
    for (const finishedAt of [
      '2026-08-08T07:00:00.000Z',
      '2026-08-08T08:00:00.000Z',
      '2026-08-08T09:00:00.000Z',
    ]) addRun(db, 'run', finishedAt);
    const materialId = addMaterial(db, '2026-08-08T06:00:00.000Z', 'active');
    const runId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, total, correct, lives_remaining)
       VALUES ('math', 'lesson', 'math.fractions', '2026-08-08T06:30:00.000Z', 5, 4, NULL)`,
    ).run().lastInsertRowid);
    db.prepare(
      'INSERT INTO learning_runs (material_id, run_id, attempt_number) VALUES (?, ?, 1)',
    ).run(materialId, runId);
    const taskId = Number(db.prepare(
      `INSERT INTO task_bank (topic_id, question, answer, difficulty, status)
       VALUES ('math.fractions', '2 + 2', '4', 1, 'lesson_reserved')`,
    ).run().lastInsertRowid);
    const attemptId = Number(db.prepare(
      `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
       VALUES (?, 'math.fractions', ?, '4', 1)`,
    ).run(taskId, runId).lastInsertRowid);
    db.prepare('INSERT INTO disputes (attempt_id, status) VALUES (?, \'open\')').run(attemptId);

    expect(readDailyGate(db, new Date('2026-08-08T12:00:00.000Z'))).toMatchObject({
      completed: 3,
      learning: { materialId, required: true, passed: false },
      unlocked: false,
    });
  });
});
