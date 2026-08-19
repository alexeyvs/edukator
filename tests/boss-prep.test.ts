import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { BOSS_MASTERY, concedeBoss, nextBossTask, startBoss, submitBossAnswer } from '../server/boss.js';
import {
  MAX_BATCHES_PER_BOSS,
  PREPARING_STALE_MS,
  prepareNextBoss,
} from '../server/boss-prep.js';
import { CodexUnavailableError } from '../server/codex/client.js';
import { CodexConcurrency } from '../server/codex/concurrency.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { runWarmupCycle } from '../server/codex/worker.js';
import { buildTopicGraph, syncTopicState, type TopicGraph } from '../server/curriculum.js';
import { openDatabase, writeProfile } from '../server/db.js';

const TOPIC = 'math.fractions';
const NOW = new Date('2026-08-08T10:00:00.000Z');

function task(label: string): GeneratedTask {
  return {
    instruction: `Свежий босс ${label}: сколько будет 10 + ${label}?`,
    material: '', material_format: 'none', choices: [], answer: '11', accept: ['11'],
    hint: 'Сложи по частям.', explain: 'Складываем.', joke: 'Босс считает.', difficulty: 2,
  };
}

function five(prefix: string): GeneratedTask[] {
  return Array.from({ length: 5 }, (_, index) => task(`${prefix}-${index + 1}`));
}

describe('подготовка боёв с боссом', () => {
  let tempDir: string;
  let db: Database;
  let graph: TopicGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-boss-prep-'));
    db = openDatabase(join(tempDir, 'boss-prep.db'));
    graph = buildTopicGraph([{
      id: TOPIC, subject: 'math', title: 'Дроби', examWeight: 3, difficulty: 3,
      prereqs: [], answerFormat: 'number', promptSeed: 'Задачи на дроби.',
    }]);
    syncTopicState(db, graph);
    writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('держит буквальные пределы подготовки', () => {
    expect(MAX_BATCHES_PER_BOSS).toBe(4);
    expect(PREPARING_STALE_MS).toBe(1_800_000);
  });

  it('claim-ит тему только строго выше 0.75 и передаёт профиль со сложностью', async () => {
    const requests: Parameters<Parameters<typeof prepareNextBoss>[0]['produce']>[0][] = [];
    const produce = (request: (typeof requests)[number]): Promise<GeneratedTask[]> => {
      requests.push(request);
      return Promise.resolve(five('first'));
    };
    db.prepare('UPDATE topic_state SET mastery = ? WHERE topic_id = ?').run(BOSS_MASTERY, TOPIC);
    expect(await prepareNextBoss({ db, graph, produce, now: NOW })).toMatchObject({ batches: 0, ready: false });

    db.prepare('UPDATE topic_state SET mastery = ? WHERE topic_id = ?').run(BOSS_MASTERY + 0.000001, TOPIC);
    const report = await prepareNextBoss({ db, graph, produce, now: NOW });
    expect(report).toMatchObject({ topicId: TOPIC, batches: 1, stored: 5, ready: true });
    expect(requests[0]).toMatchObject({ difficulty: 3, profile: { name: 'Тимофей', interests: ['Minecraft'] } });
    expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(report.batchId)).toEqual({ status: 'ready' });
  });

  it('собирает пять уникальных заданий из ограниченного числа отдельных батчей', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.8 WHERE topic_id = ?').run(TOPIC);
    let calls = 0;
    const duplicate = task('repeat');
    const report = await prepareNextBoss({
      db, graph, now: NOW,
      produce: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? [duplicate, duplicate, task('one')]
          : [task('two'), task('three'), task('four')]);
      },
    });
    expect(report).toMatchObject({ batches: 2, stored: 5, ready: true });
    expect(calls).toBe(2);

    db.prepare("UPDATE boss_batches SET status = 'failed' WHERE id = ?").run(report.batchId);
    const short = await prepareNextBoss({
      db, graph, now: new Date(NOW.getTime() + 1), maxBatches: 2,
      produce: () => Promise.resolve([duplicate]),
    });
    expect(short).toMatchObject({ batches: 2, stored: 0, ready: false, error: expect.stringContaining('0 из 5') });
  });

  it('после поражения готовит пять других отпечатков', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.76 WHERE topic_id = ?').run(TOPIC);
    await prepareNextBoss({ db, graph, produce: () => Promise.resolve(five('old')), now: NOW });
    const { runId } = startBoss(db, graph, TOPIC, { now: NOW });
    const first = nextBossTask(db, graph, runId);
    submitBossAnswer(db, graph, { runId, taskId: first.task.id, answer: '999', at: NOW });
    concedeBoss(db, runId, { now: new Date(NOW.getTime() + 1000) });
    const masteryAfterLoss = db.prepare<[string], { mastery: number }>(
      'SELECT mastery FROM topic_state WHERE topic_id = ?',
    ).get(TOPIC)?.mastery;
    expect(masteryAfterLoss).toBeLessThanOrEqual(BOSS_MASTERY);

    const old = db.prepare<[], { fingerprint: string }>(
      `SELECT fingerprint FROM task_bank WHERE status = 'boss_reserved'`,
    ).all().map(({ fingerprint }) => fingerprint);
    const report = await prepareNextBoss({
      db, graph, produce: () => Promise.resolve([...five('old'), ...five('new')]),
      now: new Date(NOW.getTime() + 2000),
    });
    const current = db.prepare<[number], { fingerprint: string }>(
      `SELECT task_bank.fingerprint FROM boss_tasks
        JOIN task_bank ON task_bank.id = boss_tasks.task_id WHERE boss_tasks.batch_id = ?`,
    ).all(report.batchId ?? 0).map(({ fingerprint }) => fingerprint);
    expect(report).toMatchObject({ stored: 5, ready: true });
    expect(current).toHaveLength(5);
    expect(current.every((fingerprint) => !old.includes(fingerprint))).toBe(true);
    expect(startBoss(db, graph, TOPIC, { now: new Date(NOW.getTime() + 3000) }))
      .toMatchObject({ batchId: report.batchId, resumed: false });
  });

  it('оставляет preparing при недоступном codex и восстанавливает зависший claim', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.8 WHERE topic_id = ?').run(TOPIC);
    const unavailable = await prepareNextBoss({
      db, graph, now: NOW,
      produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
    });
    expect(unavailable).toMatchObject({ ready: false, codexUnavailable: true });
    expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(unavailable.batchId))
      .toEqual({ status: 'preparing' });

    const restored = await prepareNextBoss({
      db, graph, now: new Date(NOW.getTime() + PREPARING_STALE_MS + 1),
      produce: () => Promise.resolve(five('restored')),
    });
    expect(restored).toMatchObject({ ready: true, recovered: true, stored: 5 });
    expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(unavailable.batchId))
      .toEqual({ status: 'failed' });
  });

  it('восстанавливает зависшую подготовку реванша ниже исходного порога', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.76 WHERE topic_id = ?').run(TOPIC);
    await prepareNextBoss({ db, graph, produce: () => Promise.resolve(five('first-fight')), now: NOW });
    const { runId } = startBoss(db, graph, TOPIC, { now: NOW });
    const first = nextBossTask(db, graph, runId);
    submitBossAnswer(db, graph, { runId, taskId: first.task.id, answer: '999', at: NOW });
    const loss = concedeBoss(db, runId, { now: new Date(NOW.getTime() + 1000) });

    const restored = await prepareNextBoss({
      db, graph,
      now: new Date(NOW.getTime() + PREPARING_STALE_MS + 2000),
      produce: () => Promise.resolve(five('recovered-rematch')),
    });

    expect(restored).toMatchObject({ ready: true, recovered: true, stored: 5 });
    expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(loss.replacementBatchId))
      .toEqual({ status: 'failed' });
    expect(startBoss(db, graph, TOPIC, { now: new Date(NOW.getTime() + PREPARING_STALE_MS + 3000) }))
      .toMatchObject({ batchId: restored.batchId, resumed: false });
  });

  // Диспетчер обходит одного ребёнка дважды за обход: сначала добивая банк до
  // порога всем поровну, потом до полного запаса. Босса заказывает только
  // второй заход, и «пропустить фазу» обязано значить «не звать модель».
  it('не заказывает бой, когда фаза подготовки босса выключена', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.8 WHERE topic_id = ?').run(TOPIC);
    let calls = 0;
    const report = await runWarmupCycle({
      db, graph, prepareBoss: false, target: 1, threshold: 1, now: () => NOW,
      produce: () => {
        calls += 1;
        return Promise.resolve(five(`floor-${String(calls)}`));
      },
    });

    expect(report.bossPreparation).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM boss_batches').get()).toEqual({ n: 0 });
    // Вызов был ровно один — обычный долив темы, а не подготовка боя.
    expect(calls).toBe(1);
    expect(report.refilled[0]).toMatchObject({ topicId: TOPIC, stored: 5 });
  });

  it('встроена в обычный цикл и делит с прогревом единый предел процессов', async () => {
    db.prepare('UPDATE topic_state SET mastery = 0.8 WHERE topic_id = ?').run(TOPIC);
    const budget = new CodexConcurrency(1);
    let active = 0;
    let peak = 0;
    let call = 0;
    const produce = async (): Promise<GeneratedTask[]> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      call += 1;
      return five(`limited-${call}`);
    };
    const report = await runWarmupCycle({
      db, graph, produce, budget, target: 1, threshold: 1, now: () => NOW,
    });
    expect(peak).toBe(1);
    expect(report.bossPreparation).toMatchObject({ ready: true, stored: 5 });
    expect(report.refilled[0]).toMatchObject({ topicId: TOPIC, stored: 5 });
  });
});
