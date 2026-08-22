import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { startTenantServer, type TenantServer } from './server-harness.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { reserveBossTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { registerBossRoutes, registerUnavailableBoss } from '../server/routes/boss.js';
import { fakeContext } from './tenant-context-helper.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOPIC = 'math.a';

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(join(dir, `${subject}.json`), JSON.stringify({
      subject,
      topics: [{
        id: `${subject}.a`, subject, title: `Тема ${subject}`, exam_weight: 3,
        difficulty: 2, prereqs: [], answer_format: 'number', prompt_seed: `Задания по теме ${subject}`,
      }],
    }));
  }
}

function tasks(): GeneratedTask[] {
  return Array.from({ length: 5 }, (_, index) => ({
    instruction: `Задание босса ${index + 1}`,
    material: `${index + 1} + 10`, material_format: 'math', choices: [],
    answer: String(index + 11), accept: [String(index + 11)],
    hint: 'СКРЫТАЯ ПОДСКАЗКА', explain: 'Складываем.', joke: 'Босс считает.', difficulty: 2,
  }));
}

describe('маршруты босса', () => {
  let dir: string;
  let curriculumDir: string;
  let seedDir: string;
  let server: TenantServer;
  let app: FastifyInstance;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-boss-routes-'));
    curriculumDir = join(dir, 'curriculum');
    seedDir = join(dir, 'seed');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    server = await startTenantServer({
      dataDir: join(dir, 'data'),
      curriculumDir,
      seedDir,
      now: () => NOW,
      worker: false,
    });
    app = server.app;
    db = openDatabase(server.dbPath);
  });

  afterEach(async () => {
    db.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ready(): number {
    db.prepare('UPDATE topic_state SET mastery = .8 WHERE topic_id = ?').run(TOPIC);
    const id = Number(db.prepare(
      "INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing')",
    ).run(TOPIC).lastInsertRowid);
    expect(reserveBossTasks(db, id, tasks()).ready).toBe(true);
    return id;
  }

  async function start(): Promise<number> {
    ready();
    const response = await app.inject({ method: 'POST', url: '/api/boss/start', payload: { topic_id: TOPIC } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { runId: number }).runId;
  }

  it('отдаёт карту состояний и проводит победный бой общим безопасным JSON задания', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/boss/topics' });
    expect(initial.statusCode).toBe(200);
    expect((initial.json() as { topics: unknown[] }).topics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: TOPIC, title: 'Тема math', subject: 'math',
        readiness: { status: 'working', eligible: false },
      }),
    ]));

    const runId = await start();
    expect((await app.inject({ method: 'GET', url: `/api/boss/${runId}/state` })).json())
      .toMatchObject({ outcome: 'active', progress: { total: 0, correct: 0 } });
    for (let position = 1; position <= 5; position += 1) {
      const next = await app.inject({ method: 'GET', url: `/api/boss/${runId}/next` });
      expect(next.statusCode).toBe(200);
      const body = next.json() as { position: number; task: Record<string, unknown> & { id: number } };
      expect(body.position).toBe(position);
      expect(body.task).toMatchObject({
        topic_id: TOPIC, topic_title: 'Тема math', subject: 'math',
        instruction: `Задание босса ${position}`, material_format: 'math', answer_format: 'number',
      });
      expect(body.task).not.toHaveProperty('answer');
      expect(body.task).not.toHaveProperty('accept');
      expect(body.task).not.toHaveProperty('hint');
      expect(body.task).not.toHaveProperty('deep_hint');

      const answer = await app.inject({
        method: 'POST', url: `/api/boss/${runId}/answer`,
        payload: { task_id: body.task.id, answer: String(position + 10), duration_ms: 1000 },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({
        correct: true,
        outcome: position === 5 ? 'won' : 'active',
        progress: { total: position, correct: position, target: 5, done: position === 5 },
      });
    }
    expect((await app.inject({ method: 'GET', url: '/api/boss/topics' })).json())
      .toMatchObject({ topics: expect.arrayContaining([
        expect.objectContaining({ id: TOPIC, readiness: expect.objectContaining({ status: 'closed' }) }),
      ]) });
    expect((await app.inject({ method: 'GET', url: `/api/boss/${runId}/state` })).json())
      .toMatchObject({ outcome: 'won', progress: { total: 5, correct: 5, done: true } });
  });

  it('отображает недоступность, ошибки запроса и конфликты состояния стабильными кодами', async () => {
    const ineligible = await app.inject({ method: 'POST', url: '/api/boss/start', payload: { topic_id: TOPIC } });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json()).toMatchObject({ code: 'boss-not-eligible' });
    db.prepare('UPDATE topic_state SET mastery = .8 WHERE topic_id = ?').run(TOPIC);
    const notReady = await app.inject({ method: 'POST', url: '/api/boss/start', payload: { topic_id: TOPIC } });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ code: 'boss-not-ready' });
    expect((await app.inject({ method: 'POST', url: '/api/boss/start', payload: {} })).statusCode).toBe(400);
    const unknownTopic = await app.inject({
      method: 'POST', url: '/api/boss/start', payload: { topic_id: 'math.unknown' },
    });
    expect(unknownTopic.statusCode).toBe(404);
    expect(unknownTopic.json()).toMatchObject({ code: 'boss-not-found' });
    const missing = await app.inject({ method: 'GET', url: '/api/boss/4242/next' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'boss-not-found' });
    expect((await app.inject({ method: 'GET', url: '/api/boss/nope/next' })).statusCode).toBe(400);

    const batchId = Number(db.prepare(
      "INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing')",
    ).run(TOPIC).lastInsertRowid);
    reserveBossTasks(db, batchId, tasks());
    const started = await app.inject({ method: 'POST', url: '/api/boss/start', payload: { topic_id: TOPIC } });
    const runId = (started.json() as { runId: number }).runId;
    const first = await app.inject({ method: 'GET', url: `/api/boss/${runId}/next` });
    const taskId = (first.json() as { task: { id: number } }).task.id;
    const otherTaskId = (db.prepare<[number], { task_id: number }>(
      'SELECT task_id FROM boss_tasks WHERE batch_id = ? AND position = 2',
    ).get(batchId) as { task_id: number }).task_id;
    const wrongTask = await app.inject({
      method: 'POST', url: `/api/boss/${runId}/answer`, payload: { task_id: otherTaskId, answer: '12' },
    });
    expect(wrongTask.statusCode).toBe(409);
    expect(wrongTask.json()).toMatchObject({ code: 'boss-wrong-task' });
    const hinted = await app.inject({
      method: 'POST', url: `/api/boss/${runId}/answer`,
      payload: { task_id: taskId, answer: '11', hint_used: true },
    });
    expect(hinted.statusCode).toBe(400);
    expect(hinted.json()).toMatchObject({ code: 'boss-hint-forbidden' });
    const premature = await app.inject({ method: 'POST', url: `/api/boss/${runId}/concede` });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toMatchObject({ code: 'boss-mistake-pending' });

    const wrong = await app.inject({
      method: 'POST', url: `/api/boss/${runId}/answer`, payload: { task_id: taskId, answer: '999' },
    });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toMatchObject({ outcome: 'mistake' });
    const attemptId = (wrong.json() as { attemptId: number }).attemptId;
    db.prepare("INSERT INTO disputes (attempt_id, status) VALUES (?, 'open')").run(attemptId);
    const disputed = await app.inject({ method: 'GET', url: `/api/boss/${runId}/next` });
    expect(disputed.statusCode).toBe(409);
    expect(disputed.json()).toMatchObject({ code: 'boss-dispute-open' });
    db.prepare('DELETE FROM disputes WHERE attempt_id = ?').run(attemptId);
    const blocked = await app.inject({ method: 'GET', url: `/api/boss/${runId}/next` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'boss-mistake-pending' });
    const conceded = await app.inject({ method: 'POST', url: `/api/boss/${runId}/concede` });
    expect(conceded.statusCode).toBe(200);
    expect(conceded.json()).toMatchObject({ runId, batchId });
    const finished = await app.inject({ method: 'GET', url: `/api/boss/${runId}/next` });
    expect(finished.statusCode).toBe(409);
    expect(finished.json()).toMatchObject({ code: 'boss-finished' });
    db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?').run(NOW.toISOString(), TOPIC);
    const closed = await app.inject({ method: 'POST', url: '/api/boss/start', payload: { topic_id: TOPIC } });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: 'boss-closed' });
  });

  it('оставляет неожиданную ошибку обезличенной пятисоткой', async () => {
    db.prepare("DELETE FROM topic_state WHERE topic_id = 'math.a'").run();
    const response = await app.inject({ method: 'GET', url: '/api/boss/topics' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Внутренняя ошибка сервера' });
    expect(response.body).not.toContain('topic_state');
  });

  it('отдаёт 503 для каждого boss URL при отвязанной или не поднятой базе', async () => {
    const detached = Fastify();
    registerBossRoutes(detached, {
      context: fakeContext(db, { available: () => false }),
    });
    const unavailable = Fastify();
    registerUnavailableBoss(unavailable, 'база недоступна');
    await Promise.all([detached.ready(), unavailable.ready()]);
    try {
      for (const instance of [detached, unavailable]) {
        for (const request of [
          { method: 'GET' as const, url: '/api/boss/topics' },
          { method: 'POST' as const, url: '/api/boss/start' },
          { method: 'GET' as const, url: '/api/boss/1/next' },
          { method: 'GET' as const, url: '/api/boss/1/state' },
          { method: 'POST' as const, url: '/api/boss/1/answer' },
          { method: 'POST' as const, url: '/api/boss/1/concede' },
        ]) expect((await instance.inject(request)).statusCode).toBe(503);
      }
    } finally {
      await Promise.all([detached.close(), unavailable.close()]);
    }
  });
});
