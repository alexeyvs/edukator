import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import { recordAttempt } from '../server/mastery.js';
import { readSnapshots } from '../server/forecast.js';
import { SessionError } from '../server/session.js';
import { RUN_TARGET, finishRun, runProgress, startRun } from '../server/run.js';

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

  function addAttempt(options: {
    runId?: number;
    topicId: string;
    correct: boolean;
    difficulty?: number;
    hintUsed?: boolean;
    now: Date;
  }): void {
    const difficulty = options.difficulty ?? 2;
    const hintUsed = options.hintUsed ?? false;
    const taskId = Number(
      db.prepare(
        `INSERT INTO task_bank (topic_id, question, answer, difficulty, status)
         VALUES (?, ?, ?, ?, 'used')`,
      ).run(options.topicId, `Задание ${options.now.toISOString()}`, 'ответ', difficulty)
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, hint_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      options.topicId,
      options.runId ?? null,
      'ответ',
      options.correct ? 1 : 0,
      hintUsed ? 1 : 0,
      options.now.toISOString(),
    );
    recordAttempt(db, options.topicId, {
      correct: options.correct,
      difficulty,
      hintUsed,
      at: options.now,
    });
    if (options.runId !== undefined) {
      db.prepare(
        'UPDATE runs SET total = total + 1, correct = correct + ? WHERE id = ?',
      ).run(options.correct ? 1 : 0, options.runId);
    }
  }

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

  it('при возобновлении отдаёт готовность забега к финальному экрану', () => {
    const first = startRun(db, graph, 'math', { now: at(0, 9) });
    db.prepare('UPDATE runs SET total = 12, correct = 8 WHERE id = ?').run(first.runId);

    expect(startRun(db, graph, 'math', { now: at(0, 18) })).toEqual({
      runId: first.runId,
      resumed: true,
      progress: { total: 12, correct: 8, target: 12, done: true },
    });
  });

  it('закрывает забег, считает XP и называет закрытые и просевшие темы', () => {
    addAttempt({ topicId: 'math.a', correct: true, difficulty: 3, now: at(-1, 9) });
    addAttempt({ topicId: 'math.b', correct: true, difficulty: 3, now: at(-1, 10) });
    addAttempt({ topicId: 'math.b', correct: true, difficulty: 3, now: at(-1, 11) });
    const { runId } = startRun(db, graph, 'math', { now: at(0, 9) });
    addAttempt({ runId, topicId: 'math.a', correct: true, difficulty: 3, now: at(0, 10) });
    addAttempt({ runId, topicId: 'math.b', correct: false, difficulty: 1, now: at(0, 11) });
    addAttempt({
      runId,
      topicId: 'math.a',
      correct: true,
      difficulty: 2,
      hintUsed: true,
      now: at(0, 12),
    });

    const result = finishRun(db, graph, runId, { now: at(0, 13) });

    expect(result.total).toBe(3);
    expect(result.correct).toBe(2);
    expect(result.xp).toBe(55);
    expect(result.closedTopics).toEqual([
      {
        topicId: 'math.a',
        title: 'math.a',
        before: expect.closeTo(0.455, 10),
        after: expect.any(Number),
      },
    ]);
    expect(result.closedTopics[0]?.after).toBeGreaterThanOrEqual(0.6);
    expect(result.declinedTopics).toEqual([
      {
        topicId: 'math.b',
        title: 'math.b',
        before: expect.any(Number),
        after: expect.any(Number),
      },
    ]);
    expect(result.declinedTopics[0]?.after).toBeLessThan(
      result.declinedTopics[0]?.before ?? 0,
    );
    expect(result.forecast.subject).toBe('math');
    expect(result).not.toHaveProperty('forecastDelta');
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId)).toEqual({
      finished_at: at(0, 13).toISOString(),
    });
  });

  it('на первом забеге отдаёт прогноз без сдвига, на втором — разницу снимков', () => {
    const first = startRun(db, graph, 'math', { now: at(0, 9) });
    addAttempt({ runId: first.runId, topicId: 'math.a', correct: true, now: at(0, 10) });
    const firstResult = finishRun(db, graph, first.runId, { now: at(0, 11) });

    const second = startRun(db, graph, 'math', { now: at(0, 12) });
    addAttempt({ runId: second.runId, topicId: 'math.a', correct: true, now: at(0, 13) });
    const secondResult = finishRun(db, graph, second.runId, { now: at(0, 14) });
    const snapshots = readSnapshots(db, 'math');

    expect(firstResult).not.toHaveProperty('forecastDelta');
    expect(secondResult.forecastDelta).toBeCloseTo(
      secondResult.forecast.score - firstResult.forecast.score,
      12,
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.score)).toEqual([
      firstResult.forecast.score,
      secondResult.forecast.score,
    ]);
  });

  it('отвергает повторное закрытие и неизвестный забег кодами состояния', () => {
    const { runId } = startRun(db, graph, 'math', { now: at(0, 9) });
    finishRun(db, graph, runId, { now: at(0, 10) });

    for (const [id, code] of [
      [runId, 'run-finished'],
      [999, 'run-not-found'],
    ] as const) {
      try {
        finishRun(db, graph, id, { now: at(0, 11) });
        throw new Error('фикстура: закрытие должно быть отвергнуто');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionError);
        expect((error as SessionError).code).toBe(code);
      }
    }
  });

  it('отвергает неизвестный забег и предмет вне карты тем', () => {
    expect(() => runProgress(db, 999)).toThrow(/забег.*999.*не найден/ui);
    expect(() => startRun(db, graph, 'english', { now: at(0) })).toThrow(
      /предмет.*english.*карте тем/ui,
    );
  });
});
