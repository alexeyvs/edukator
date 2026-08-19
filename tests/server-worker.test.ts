import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer, HOST } from '../server/index.js';
import { openDatabase } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { activeTopics } from '../server/scheduler.js';
import { storeTasks } from '../server/codex/bank.js';
import {
  CodexConcurrency,
  MAX_CODEX_CONCURRENCY,
  MAX_DISPUTE_CONCURRENCY,
} from '../server/codex/concurrency.js';
import { CodexUnavailableError } from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { DisputeReview } from '../server/codex/dispute.js';

function generated(question: string): GeneratedTask {
  return {
    instruction: question, material: '', material_format: 'none', choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Раздели девяносто пополам.',
    explain: '90 : 2 = 45.',
    joke: 'Арифметика без сдачи.',
    difficulty: 2,
  };
}

describe('воркер рабочего сервера', () => {
  let tempDir: string;
  let dbPath: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-server-worker-'));
    mkdirSync(join(tempDir, 'seed-bank'));
    dbPath = join(tempDir, 'worker.db');
  });

  afterEach(async () => {
    await app?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('запускает спор в отдельном слоте при занятом воркере', async () => {
    expect(MAX_CODEX_CONCURRENCY).toBe(2);
    expect(MAX_DISPUTE_CONCURRENCY).toBe(1);
    const budget = new CodexConcurrency(MAX_CODEX_CONCURRENCY);
    const disputes = new CodexConcurrency(MAX_DISPUTE_CONCURRENCY);
    const releaseProduce: ((tasks: GeneratedTask[]) => void)[] = [];
    let releaseReview: ((review: DisputeReview) => void) | undefined;
    const producingTopics: string[] = [];
    let peak = 0;
    const startedProduce = new Promise<void>((resolve) => {
      app = buildServer(undefined, {
        dbPath,
        seedDir: join(tempDir, 'seed-bank'),
        codexBudget: budget,
        disputeBudget: disputes,
        worker: {
          topics: 2,
          target: 2,
          threshold: 2,
          produce: (request) => {
            producingTopics.push(request.topic.id);
            peak = Math.max(peak, budget.active + disputes.active);
            if (producingTopics.length === MAX_CODEX_CONCURRENCY) resolve();
            return new Promise<GeneratedTask[]>((done) => {
              releaseProduce.push(done);
            });
          },
        },
        review: () => {
          peak = Math.max(peak, budget.active + disputes.active);
          return new Promise<DisputeReview>((done) => {
            releaseReview = done;
          });
        },
      });
    });
    const server = app;
    if (server === undefined) throw new Error('сервер теста не собран');

    // buildServer уже синхронизировал карту; одно готовое задание оставляет тему
    // голодной для воркера и одновременно даёт открыть спор через HTTP.
    const db = openDatabase(dbPath);
    const graph = loadCurriculum();
    const topic = activeTopics(db, graph, 1)[0];
    if (topic === undefined) throw new Error('планировщик не выбрал тему для теста');
    storeTasks(db, topic.id, [generated('В инвентаре 90 монет, половину потратили. Сколько осталось?')]);
    db.close();

    await server.listen({ host: HOST, port: 0 });
    await startedProduce;

    const next = await server.inject({ method: 'GET', url: '/api/session/next' });
    const taskId = (next.json() as { task: { id: number } }).task.id;
    const answer = await server.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: taskId, answer: '44' },
    });
    const attemptId = (answer.json() as { attempt_id: number }).attempt_id;
    const dispute = await server.inject({
      method: 'POST',
      url: '/api/session/dispute',
      payload: { attempt_id: attemptId },
    });

    expect(dispute.statusCode).toBe(202);
    await viWaitFor(() => releaseReview !== undefined);
    expect(producingTopics).toHaveLength(MAX_CODEX_CONCURRENCY);
    expect(producingTopics).toContain(topic.id);
    expect(budget.active).toBe(MAX_CODEX_CONCURRENCY);
    expect(disputes.active).toBe(1);
    expect(peak).toBe(MAX_CODEX_CONCURRENCY + MAX_DISPUTE_CONCURRENCY);
    expect(disputes.tryRun(() => Promise.resolve())).toBeUndefined();

    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseReview?.({ studentCorrect: false, note: 'ответ отличается' });
    releaseProduce.forEach((release, index) => {
      release([
        generated(`Задание для прогрева ${index + 1}, вариант 1`),
        generated(`Задание для прогрева ${index + 1}, вариант 2`),
      ]);
    });
    await closing;

    const reopened = openDatabase(dbPath);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM task_bank WHERE topic_id = ?').get(topic.id))
      .toEqual({ n: 3 });
    reopened.close();
  });

  it('при недоступном codex откладывает воркер, но оставляет обычное занятие рабочим', async () => {
    const logged: string[] = [];
    let firstDelay: number | undefined;
    let reachedWait: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      reachedWait = resolve;
    });
    app = buildServer(undefined, {
      dbPath,
      seedDir: join(tempDir, 'seed-bank'),
      log: (message) => logged.push(message),
      worker: {
        topics: 1,
        produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
        wait: async (ms) => {
          firstDelay = ms;
          reachedWait?.();
          await new Promise<void>(() => undefined);
        },
      },
    });

    const db = openDatabase(dbPath);
    const topic = activeTopics(db, loadCurriculum(), 1)[0];
    if (topic === undefined) throw new Error('планировщик не выбрал тему для теста');
    storeTasks(db, topic.id, [generated('В инвентаре 90 монет, половину потратили. Сколько осталось?')]);
    db.close();

    await app.listen({ host: HOST, port: 0 });
    await waiting;
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const next = await app.inject({ method: 'GET', url: '/api/session/next' });
    const taskId = (next.json() as { task: { id: number } }).task.id;
    const answer = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: taskId, answer: '45' },
    });

    expect(health.statusCode).toBe(200);
    expect(next.statusCode).toBe(200);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ correct: true });
    expect(firstDelay).toBe(60_000);
    expect(logged.join('\n')).toMatch(/codex недоступен.*пополнение отложено/su);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('условие теста не наступило');
}
