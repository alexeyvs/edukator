import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import { RUN_TARGET, runProgress, startRun } from '../server/run.js';

function at(day: number, hour = 12): Date {
  return new Date(Date.UTC(2026, 7, 8 + day, hour));
}

function topic(id: string, subject: Topic['subject'] = 'math'): Topic {
  return {
    id,
    subject,
    title: id,
    examWeight: 2,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: 'seed',
  };
}

function graphOf(...topics: Topic[]): TopicGraph {
  return buildTopicGraph(topics);
}

describe('жизненный цикл забега', () => {
  let tempDir: string;
  let db: Database;
  const graph = graphOf(topic('math.a'), topic('math.b'), topic('russian.a', 'russian'));

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-run-'));
    db = openDatabase(join(tempDir, 'test.db'));
    const insert = db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)');
    for (const item of graph.byId.values()) insert.run(item.id);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('держит калибровочные константы спеки', () => {
    expect(RUN_TARGET).toBe(12);
  });

  it('подхватывает незакрытый забег того же предмета в те же сутки', () => {
    db.prepare('UPDATE topic_state SET mastery = ? WHERE topic_id = ?').run(0.9, 'math.a');
    const first = startRun(db, graph, 'math', { now: at(0, 9) });
    db.prepare('UPDATE runs SET total = 4, correct = 3 WHERE id = ?').run(first.runId);

    const second = startRun(db, graph, 'math', { now: at(0, 18) });

    expect(first).toEqual({
      runId: expect.any(Number),
      resumed: false,
      progress: { total: 0, correct: 0, target: 12, done: false },
    });
    expect(second).toEqual({
      runId: first.runId,
      resumed: true,
      progress: { total: 4, correct: 3, target: 12, done: false },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT subject, topic_id FROM runs WHERE id = ?').get(first.runId)).toEqual({
      subject: 'math',
      topic_id: 'math.b',
    });
  });

  it('закрывает вчерашние забеги по последней попытке, а пустые — по старту', () => {
    const withAttempt = Number(db
      .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
      .run('math', 'math.a', at(-1, 9).toISOString()).lastInsertRowid);
    const empty = Number(db
      .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
      .run('russian', 'russian.a', at(-1, 10).toISOString()).lastInsertRowid);
    const taskId = Number(db
      .prepare(
        `INSERT INTO task_bank (topic_id, question, answer, difficulty, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('math.a', '2 + 2', '4', 1, 'used').lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, 'math.a', withAttempt, '4', 1, at(-1, 11).toISOString());
    db.prepare(
      `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, 'math.a', withAttempt, '4', 1, at(-1, 12).toISOString());

    startRun(db, graph, 'math', { now: at(0) });

    const rows = db
      .prepare<[number, number], { id: number; started_at: string; finished_at: string | null }>(
        'SELECT id, started_at, finished_at FROM runs WHERE id IN (?, ?) ORDER BY id',
      )
      .all(withAttempt, empty);
    expect(rows).toEqual([
      {
        id: withAttempt,
        started_at: at(-1, 9).toISOString(),
        finished_at: at(-1, 12).toISOString(),
      },
      {
        id: empty,
        started_at: at(-1, 10).toISOString(),
        finished_at: at(-1, 10).toISOString(),
      },
    ]);
  });

  it('считает прогресс и готовность к закрытию по счётчикам забега', () => {
    const { runId } = startRun(db, graph, 'math', { now: at(0) });
    db.prepare('UPDATE runs SET total = 12, correct = 9 WHERE id = ?').run(runId);

    expect(runProgress(db, runId)).toEqual({ total: 12, correct: 9, target: 12, done: true });
  });

  it('отвергает неизвестный забег и предмет вне карты тем', () => {
    expect(() => runProgress(db, 999)).toThrow(/забег.*999.*не найден/ui);
    expect(() => startRun(db, graph, 'english', { now: at(0) })).toThrow(
      /предмет.*english.*карте тем/ui,
    );
  });
});
