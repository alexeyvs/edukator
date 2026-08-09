import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import { readTopicState, recordAttempt } from '../server/mastery.js';
import { readSnapshots } from '../server/forecast.js';
import { openDispute, SessionError } from '../server/session.js';
import { RUN_TARGET, finishRun, isRunKind, runProgress, startRun } from '../server/run.js';

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

  it('распознаёт все допустимые виды забега одним runtime guard', () => {
    expect(['run', 'triage', 'boss', 'lesson'].every(isRunKind)).toBe(true);
    expect(isRunKind('exam')).toBe(false);
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

  it('стартует тему выбранной карточки, а не первую тему того же предмета', () => {
    const started = startRun(db, graph, 'math', { now: at(0, 9), topicId: 'math.b' });

    expect(db.prepare('SELECT topic_id FROM runs WHERE id = ?').get(started.runId))
      .toEqual({ topic_id: 'math.b' });
  });

  it('карточка другой темы возобновляет текущий забег по тому же предмету', () => {
    const first = startRun(db, graph, 'math', { now: at(0, 9), topicId: 'math.a' });

    const resumed = startRun(db, graph, 'math', { now: at(0, 18), topicId: 'math.b' });

    expect(resumed).toMatchObject({ runId: first.runId, resumed: true });
    expect(db.prepare('SELECT topic_id FROM runs WHERE id = ?').get(first.runId))
      .toEqual({ topic_id: 'math.a' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
  });

  it('отвергает устаревшую карточку уже закрытой темы', () => {
    db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?')
      .run(at(0, 8).toISOString(), 'math.b');

    expect(() => startRun(db, graph, 'math', { now: at(0, 9), topicId: 'math.b' }))
      .toThrowError(expect.objectContaining({ code: 'run-topic-unavailable' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });

  it('переключает сутки забега по московской полуночи при UTC-поясе процесса', () => {
    const first = startRun(db, graph, 'math', {
      now: new Date('2026-08-07T20:50:00.000Z'), topicId: 'math.a',
    });
    const second = startRun(db, graph, 'math', {
      now: new Date('2026-08-07T21:10:00.000Z'), topicId: 'math.a',
    });

    expect(second.resumed).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(first.runId))
      .toEqual({ finished_at: '2026-08-07T20:50:00.000Z' });
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

  it('не закрывает вчерашний забег, пока по нему открыт спор', () => {
    const runId = Number(db
      .prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
      .run('math', 'math.a', at(-1, 9).toISOString()).lastInsertRowid);
    addAttempt({ runId, topicId: 'math.a', correct: false, now: at(-1, 11) });
    const attempt = db.prepare<[number], { id: number }>(
      'SELECT id FROM attempts WHERE run_id = ? ORDER BY id DESC LIMIT 1',
    ).get(runId);
    if (attempt === undefined) throw new Error('попытка не записалась');
    openDispute(db, attempt.id);

    startRun(db, graph, 'russian', { now: at(0) });

    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId)).toEqual({
      finished_at: null,
    });
  });

  it('не бросает активного босса при старте нового дня', () => {
    const bossRun = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES ('math', 'boss', 'math.a', ?)`,
    ).run(at(-1, 9).toISOString()).lastInsertRowid);
    db.prepare(
      `INSERT INTO boss_batches (topic_id, run_id, status, activated_at)
       VALUES ('math.a', ?, 'active', ?)`,
    ).run(bossRun, at(-1, 9).toISOString());

    startRun(db, graph, 'russian', { now: at(0) });

    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(bossRun))
      .toEqual({ finished_at: null });
    expect(db.prepare('SELECT status FROM boss_batches WHERE run_id = ?').get(bossRun))
      .toEqual({ status: 'active' });
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
    const { runId } = startRun(db, graph, 'math', { now: at(0, 9), kind: 'triage' });
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
    expect(result.touchedTopics).toEqual([
      expect.objectContaining({ topicId: 'math.a', title: 'math.a' }),
      expect.objectContaining({ topicId: 'math.b', title: 'math.b' }),
    ]);
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
    const first = startRun(db, graph, 'math', { now: at(0, 9), kind: 'triage' });
    addAttempt({ runId: first.runId, topicId: 'math.a', correct: true, now: at(0, 10) });
    const firstResult = finishRun(db, graph, first.runId, { now: at(0, 11) });

    const second = startRun(db, graph, 'math', { now: at(0, 12), kind: 'triage' });
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

  it('повторно отдаёт тот же итог и отвергает неизвестный забег', () => {
    const { runId } = startRun(db, graph, 'math', { now: at(0, 9), kind: 'triage' });
    const first = finishRun(db, graph, runId, { now: at(0, 10) });

    expect(finishRun(db, graph, runId, { now: at(0, 11) })).toEqual(first);
    expect(readSnapshots(db, 'math')).toHaveLength(1);
    try {
      finishRun(db, graph, 999, { now: at(0, 11) });
      throw new Error('фикстура: неизвестный забег должен быть отвергнут');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe('run-not-found');
    }
  });

  it('не закрывает незавершённый забег и забег с открытым спором', () => {
    const ordinary = startRun(db, graph, 'math', { now: at(0, 9) });
    expect(() => finishRun(db, graph, ordinary.runId, { now: at(0, 10) }))
      .toThrow(expect.objectContaining({ code: 'run-not-ready' }));

    db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?')
      .run(at(0, 10).toISOString(), ordinary.runId);
    const triage = startRun(db, graph, 'math', { now: at(0, 11), kind: 'triage' });
    addAttempt({ runId: triage.runId, topicId: 'math.a', correct: false, now: at(0, 12) });
    const attempt = db.prepare<[], { id: number }>('SELECT id FROM attempts ORDER BY id DESC').get();
    if (attempt === undefined) throw new Error('фикстура: попытка не записана');
    openDispute(db, attempt.id);

    expect(() => finishRun(db, graph, triage.runId, { now: at(0, 13) }))
      .toThrow(expect.objectContaining({ code: 'run-not-ready' }));
  });

  it('не приписывает итогу попытки, сделанные после последнего ответа забега', () => {
    const run = startRun(db, graph, 'math', { now: at(0, 9), kind: 'triage' });
    addAttempt({ runId: run.runId, topicId: 'math.a', correct: true, now: at(0, 10) });
    const afterRun = readTopicState(db, 'math.a').mastery;
    addAttempt({ topicId: 'math.a', correct: false, now: at(0, 11) });

    const result = finishRun(db, graph, run.runId, { now: at(0, 12) });

    expect(result.touchedTopics).toEqual([
      expect.objectContaining({ topicId: 'math.a', after: expect.closeTo(afterRun, 10) }),
    ]);
  });

  it('отвергает неизвестный забег и предмет вне карты тем', () => {
    expect(() => runProgress(db, 999)).toThrow(/забег.*999.*не найден/ui);
    expect(() => startRun(db, graph, 'english', { now: at(0) })).toThrow(
      /предмет.*english.*карте тем/ui,
    );
  });
});
