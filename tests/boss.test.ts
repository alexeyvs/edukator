import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, syncTopicState, type TopicGraph } from '../server/curriculum.js';
import { reserveBossTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { openDispute } from '../server/session.js';
import {
  BOSS_MASTERY,
  BOSS_TARGET,
  BossError,
  bossTopicState,
  concedeBoss,
  nextBossTask,
  startBoss,
  submitBossAnswer,
} from '../server/boss.js';

const TOPIC = 'math.fractions';
const NOW = new Date('2026-08-08T10:00:00.000Z');

function tasks(): GeneratedTask[] {
  return Array.from({ length: 5 }, (_, index) => ({
    instruction: `Босс ${index + 1}: сколько будет ${index + 1} + 10?`,
    material: '', material_format: 'none', choices: [],
    answer: String(index + 11), accept: [String(index + 11)],
    hint: 'Секретная подсказка', explain: 'Складываем.', joke: 'Босс считает.', difficulty: 2,
  }));
}

describe('доменная модель босса', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let graph: TopicGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-boss-'));
    dbPath = join(tempDir, 'boss.db');
    db = openDatabase(dbPath);
    graph = buildTopicGraph([{
      id: TOPIC, subject: 'math', title: 'Дроби', examWeight: 3, difficulty: 2,
      prereqs: [], answerFormat: 'number', promptSeed: 'Задачи на дроби.',
    }]);
    syncTopicState(db, graph);
    db.prepare('UPDATE topic_state SET mastery = 0.8 WHERE topic_id = ?').run(TOPIC);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function prepare(database: Database = db): number {
    const batchId = Number(database.prepare(
      "INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing')",
    ).run(TOPIC).lastInsertRowid);
    expect(reserveBossTasks(database, batchId, tasks()).ready).toBe(true);
    return batchId;
  }

  function active(database: Database = db): { batchId: number; runId: number } {
    const batchId = prepare(database);
    const started = startBoss(database, graph, TOPIC, { now: NOW });
    return { batchId, runId: started.runId };
  }

  it('держит буквальные пороги спеки', () => {
    expect(BOSS_MASTERY).toBe(0.75);
    expect(BOSS_TARGET).toBe(5);
  });

  it('показывает все состояния темы и требует строго больше порога', () => {
    db.prepare('UPDATE topic_state SET mastery = 0.75 WHERE topic_id = ?').run(TOPIC);
    expect(bossTopicState(db, TOPIC)).toEqual({ status: 'working', eligible: false });
    db.prepare('UPDATE topic_state SET mastery = 0.750001 WHERE topic_id = ?').run(TOPIC);
    expect(bossTopicState(db, TOPIC)).toEqual({ status: 'working', eligible: true });

    const batchId = Number(db.prepare(
      "INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing')",
    ).run(TOPIC).lastInsertRowid);
    expect(bossTopicState(db, TOPIC)).toMatchObject({ status: 'preparing', batchId });
    reserveBossTasks(db, batchId, tasks());
    expect(bossTopicState(db, TOPIC)).toMatchObject({ status: 'ready', batchId });
    const started = startBoss(db, graph, TOPIC, { now: NOW });
    expect(bossTopicState(db, TOPIC)).toMatchObject({ status: 'active', runId: started.runId });
    db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?').run(NOW.toISOString(), TOPIC);
    expect(bossTopicState(db, TOPIC)).toEqual({ status: 'closed', eligible: false });
  });

  it('активирует готовый полный батч и после перезагрузки подхватывает тот же бой', () => {
    const batchId = prepare();
    const first = startBoss(db, graph, TOPIC, { now: NOW });
    const second = startBoss(db, graph, TOPIC, { now: new Date(NOW.getTime() + 1000) });

    expect(first).toEqual({ batchId, runId: first.runId, resumed: false });
    expect(second).toEqual({ batchId, runId: first.runId, resumed: true });
    expect(db.prepare('SELECT kind, topic_id, finished_at FROM runs WHERE id = ?').get(first.runId))
      .toEqual({ kind: 'boss', topic_id: TOPIC, finished_at: null });
  });

  it('два запроса старта создают один бой', () => {
    prepare();
    const other = openDatabase(dbPath);
    try {
      const first = startBoss(db, graph, TOPIC, { now: NOW });
      const second = startBoss(other, graph, TOPIC, { now: NOW });
      expect(second).toMatchObject({ runId: first.runId, resumed: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'boss'").get()).toEqual({ n: 1 });
    } finally {
      other.close();
    }
  });

  it('выдаёт только текущую позицию без ответа, accept и подсказки', () => {
    const { runId } = active();
    const first = nextBossTask(db, graph, runId);
    expect(first.position).toBe(1);
    expect(first.task.question).toContain('Босс 1');
    expect(Object.keys(first.task).sort()).toEqual([
      'answerFormat', 'choices', 'difficulty', 'id', 'instruction', 'material',
      'materialFormat', 'question', 'subject', 'topicId', 'topicTitle',
    ]);
    expect(JSON.stringify(first.task)).not.toContain('Секретная подсказка');

    submitBossAnswer(db, graph, { runId, taskId: first.task.id, answer: '11', at: NOW });
    expect(nextBossTask(db, graph, runId).position).toBe(2);
  });

  it('запрещает подсказку, чужое задание и следующий ответ после ошибки', () => {
    const { runId } = active();
    const first = nextBossTask(db, graph, runId);
    expect(() => submitBossAnswer(db, graph, {
      runId, taskId: first.task.id, answer: '11', hintUsed: true, at: NOW,
    })).toThrow(/подсказ/u);
    const foreign = db.prepare<[number, number], { task_id: number }>(
      'SELECT task_id FROM boss_tasks WHERE batch_id = ? AND position = ?',
    ).get(first.batchId, 2)?.task_id ?? 0;
    expect(() => submitBossAnswer(db, graph, {
      runId, taskId: foreign, answer: '12', at: NOW,
    })).toThrow(/текущ/u);

    const wrong = submitBossAnswer(db, graph, {
      runId, taskId: first.task.id, answer: '999', at: NOW,
    });
    expect(wrong).toMatchObject({ correct: false, outcome: 'mistake', xp: 0 });
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId)).toEqual({ finished_at: null });
    expect(() => nextBossTask(db, graph, runId)).toThrow(/ошибк/u);
    expect(() => submitBossAnswer(db, graph, {
      runId, taskId: foreign, answer: '12', at: NOW,
    })).toThrow(/ошибк/u);
  });

  it('не выдаёт задание при открытом споре', () => {
    const { runId } = active();
    const first = nextBossTask(db, graph, runId);
    const answer = submitBossAnswer(db, graph, {
      runId, taskId: first.task.id, answer: '999', at: NOW,
    });
    openDispute(db, answer.attemptId);
    expect(() => nextBossTask(db, graph, runId)).toThrow(/спор/u);
  });

  it('признание поражения закрывает бой без дополнительного штрафа и ставит новый батч', () => {
    const { batchId, runId } = active();
    const first = nextBossTask(db, graph, runId);
    submitBossAnswer(db, graph, { runId, taskId: first.task.id, answer: '999', at: NOW });
    const masteryAfterAnswer = db.prepare<[string], { mastery: number }>(
      'SELECT mastery FROM topic_state WHERE topic_id = ?',
    ).get(TOPIC)?.mastery;

    const result = concedeBoss(db, runId, { now: new Date(NOW.getTime() + 1000) });
    expect(result).toMatchObject({ runId, batchId, replacementBatchId: expect.any(Number) });
    expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(batchId)).toEqual({ status: 'lost' });
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: '2026-08-08T10:00:01.000Z' });
    expect(db.prepare('SELECT mastery FROM topic_state WHERE topic_id = ?').get(TOPIC))
      .toEqual({ mastery: masteryAfterAnswer });
    expect(bossTopicState(db, TOPIC)).toMatchObject({ status: 'preparing' });
  });

  it('пятый верный ответ атомарно завершает победу, начисляет taskXp и закрывает тему', () => {
    const { batchId, runId } = active();
    let last: ReturnType<typeof submitBossAnswer> | undefined;
    for (let index = 0; index < 5; index += 1) {
      const current = nextBossTask(db, graph, runId);
      last = submitBossAnswer(db, graph, {
        runId, taskId: current.task.id, answer: String(index + 11),
        at: new Date(NOW.getTime() + index * 1000),
      });
      expect(last.xp).toBe(25);
    }

    expect(last).toMatchObject({ correct: true, outcome: 'won', progress: { total: 5, correct: 5, done: true } });
    expect(db.prepare('SELECT status, finished_at FROM boss_batches WHERE id = ?').get(batchId))
      .toEqual({ status: 'won', finished_at: '2026-08-08T10:00:04.000Z' });
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: '2026-08-08T10:00:04.000Z' });
    expect(db.prepare('SELECT closed_at FROM topic_state WHERE topic_id = ?').get(TOPIC))
      .toEqual({ closed_at: '2026-08-08T10:00:04.000Z' });
    expect(() => nextBossTask(db, graph, runId)).toThrow(BossError);
  });

  it('два запроса победного ответа фиксируют ровно одну попытку и одно закрытие', () => {
    const { runId } = active();
    for (let index = 0; index < 4; index += 1) {
      const current = nextBossTask(db, graph, runId);
      submitBossAnswer(db, graph, { runId, taskId: current.task.id, answer: String(index + 11), at: NOW });
    }
    const final = nextBossTask(db, graph, runId);
    const other = openDatabase(dbPath);
    try {
      submitBossAnswer(db, graph, { runId, taskId: final.task.id, answer: '15', at: NOW });
      expect(() => submitBossAnswer(other, graph, {
        runId, taskId: final.task.id, answer: '15', at: NOW,
      })).toThrow(/заверш/u);
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?').get(runId)).toEqual({ n: 5 });
    } finally {
      other.close();
    }
  });

  it('отвергает закрытую тему, ровно 0.75 и отсутствие полного батча', () => {
    db.prepare('UPDATE topic_state SET mastery = 0.75 WHERE topic_id = ?').run(TOPIC);
    expect(() => startBoss(db, graph, TOPIC, { now: NOW })).toThrow(/недоступ/u);
    db.prepare('UPDATE topic_state SET mastery = 0.8, closed_at = ? WHERE topic_id = ?')
      .run(NOW.toISOString(), TOPIC);
    expect(() => startBoss(db, graph, TOPIC, { now: NOW })).toThrow(/закрыт/u);
    db.prepare('UPDATE topic_state SET closed_at = NULL WHERE topic_id = ?').run(TOPIC);
    db.prepare("INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing')").run(TOPIC);
    expect(() => startBoss(db, graph, TOPIC, { now: NOW })).toThrow(/готов/u);
  });

  it('отвергает несогласованные batch, run и task и шестой ответ', () => {
    const { batchId, runId } = active();
    db.prepare("UPDATE runs SET kind = 'run' WHERE id = ?").run(runId);
    expect(() => nextBossTask(db, graph, runId)).toThrow(/несогласован/u);
    db.prepare("UPDATE runs SET kind = 'boss', total = 5, correct = 5 WHERE id = ?").run(runId);
    expect(() => nextBossTask(db, graph, runId)).toThrow(/пят/u);
    db.prepare('UPDATE runs SET total = 0, correct = 0 WHERE id = ?').run(runId);
    const taskId = db.prepare<[number], { task_id: number }>(
      'SELECT task_id FROM boss_tasks WHERE batch_id = ? AND position = 1',
    ).get(batchId)?.task_id ?? 0;
    db.prepare('UPDATE task_bank SET issued_run_id = NULL WHERE id = ?').run(taskId);
    expect(() => submitBossAnswer(db, graph, { runId, taskId, answer: '11', at: NOW }))
      .toThrow(/несогласован/u);
  });
});
