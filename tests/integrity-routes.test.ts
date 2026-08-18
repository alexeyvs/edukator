import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildServer } from '../server/index.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { IntegrityCoordinator, IntegrityPublicStatus } from '../server/integrity.js';
import {
  registerIntegrityRoutes,
  registerUnavailableIntegrity,
} from '../server/routes/integrity.js';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const PIN = '123456';

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(join(dir, `${subject}.json`), JSON.stringify({
      subject,
      topics: [{
        id: `${subject}.a`, subject, title: `Тема ${subject}`, exam_weight: 3,
        difficulty: 2, prereqs: [], answer_format: 'number', prompt_seed: 'Решай примеры.',
      }],
    }));
  }
}

function task(index: number): GeneratedTask {
  return {
    instruction: `Вычисли пример ${index}.`, material: '40 + 5', material_format: 'math',
    choices: [], answer: '45', accept: ['45'], difficulty: 2,
    hint: 'Сложи десятки и единицы, затем проверь обратным действием.',
    explain: '40 + 5 = 45.', joke: 'Ответ на месте.',
  };
}

describe('HTTP-поток проверки осмысленности', () => {
  let dir: string;
  let app: FastifyInstance;
  let db: Database;
  let reviewBatches: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-integrity-routes-'));
    const curriculum = join(dir, 'curriculum');
    const seed = join(dir, 'seed');
    mkdirSync(curriculum);
    mkdirSync(seed);
    writeCurriculum(curriculum);
    process.env.EDUKATOR_DB = join(dir, 'test.db');
    reviewBatches = [];
    app = buildServer(curriculum, {
      seedDir: seed,
      worker: false,
      parentPin: PIN,
      now: () => NOW,
      background: (job): void => void job(),
      integrityReview: async (items) => {
        reviewBatches.push(items.length);
        return items.map((item) => {
          const junk = item.attempts.some((attempt) => attempt.answer === 'Ff');
          return {
            id: item.id,
            decision: junk ? 'junk' : 'meaningful',
            confidence: 0.99,
            reason: junk ? 'Ответ не связан с числовым заданием.' : 'Ответ осмысленный.',
          };
        });
      },
      log: (): void => undefined,
    });
    await app.ready();
    db = openDatabase(process.env.EDUKATOR_DB);
    storeTasks(db, 'math.a', Array.from({ length: 12 }, (_, index) => task(index)));
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  async function reviewState(runId: number): Promise<Record<string, unknown>> {
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const body: Record<string, unknown> = (await app.inject({
        method: 'GET', url: `/api/integrity/${runId}`,
      })).json();
      if (body['status'] !== 'checking') return body;
    }
    throw new Error('Codex-проверка не завершилась');
  }

  it('не засчитывает забег до Codex или ручного подтверждения родителя', async () => {
    const started = await app.inject({
      method: 'POST', url: '/api/run/start', payload: { subject: 'math' },
    });
    const runId = (started.json() as { runId: number }).runId;
    for (let index = 0; index < 12; index += 1) {
      const next = (await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` }))
        .json() as { task: { id: number } };
      const answer = await app.inject({
        method: 'POST', url: '/api/session/answer',
        payload: {
          task_id: next.task.id, runId, answer: index === 11 ? 'Ff' : '45',
          hint_used: false, duration_ms: index === 11 ? 1_000 : 15_000,
        },
      });
      if (index === 11) {
        expect(answer.json()).toMatchObject({ integrity_check: true });
        expect(answer.json()).not.toHaveProperty('answer');
        await app.inject({
          method: 'POST', url: '/api/session/retry/skip',
          payload: { runId, task_id: next.task.id },
        });
      }
    }

    await app.inject({ method: 'POST', url: `/api/run/${runId}/finish` });
    const review = await reviewState(runId);
    expect(review).toMatchObject({
      status: 'retry_required', flagged: 12, remaining: 1,
      retry: { task: { hint: 'Сложи десятки и единицы, затем проверь обратным действием.' } },
    });
    expect(reviewBatches).toEqual([12]);
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ completed: 0, unlocked: false });

    const dashboard = (await app.inject({ method: 'GET', url: '/api/parents' })).json() as {
      integrityReviews: Array<{ runId: number; retryRequired: number }>;
    };
    expect(dashboard.integrityReviews).toEqual([{ 
      runId, kind: 'run', subject: 'math', startedAt: NOW.toISOString(),
      status: 'needs_retry', flagged: 12, retryRequired: 1,
    }]);
    const detail: { attempts: Array<{ integrity?: { itemId: number; status: string } }> } =
      (await app.inject({ method: 'GET', url: `/api/parents/runs/${runId}` })).json();
    const item = detail.attempts.find(
      (attempt) => attempt.integrity?.status === 'retry_required',
    )?.integrity;
    if (item === undefined) throw new Error('В родительской детализации нет отметки проверки');

    const denied = await app.inject({
      method: 'PUT', url: `/api/parents/runs/${runId}/integrity/${item.itemId}/approve`,
      headers: { authorization: 'Bearer 000000' },
    });
    expect(denied.statusCode).toBe(401);
    const approved = await app.inject({
      method: 'PUT', url: `/api/parents/runs/${runId}/integrity/${item.itemId}/approve`,
      headers: { authorization: `Bearer ${PIN}` },
    });

    expect(approved.json()).toMatchObject({ status: 'completed' });
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ completed: 1 });
  });
});

function coordinatorStub(
  state: IntegrityPublicStatus | null,
  retry: IntegrityCoordinator['retry'] = () => {
    throw new Error('Повтор сейчас не ожидается');
  },
): IntegrityCoordinator {
  return {
    begin: () => ({ status: 'checking', flagged: 1 }),
    status: () => state,
    retry,
    approve: () => ({ status: 'checking', flagged: 1 }),
    stop: () => Promise.resolve(),
  };
}

describe('валидация HTTP-маршрутов проверки осмысленности', () => {
  it('отвергает некорректные идентификаторы, ответ и время', async () => {
    const app = Fastify();
    registerIntegrityRoutes(app, { coordinator: coordinatorStub(null) });
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/integrity/nope' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/integrity/1' })).statusCode).toBe(404);
      for (const url of [
        '/api/integrity/nope/retry/1',
        '/api/integrity/1/retry/0',
        '/api/integrity/999999999999999999999/retry/1',
      ]) {
        expect((await app.inject({
          method: 'POST', url, payload: { answer: '45', duration_ms: 1_000 },
        })).statusCode).toBe(400);
      }
      expect((await app.inject({
        method: 'POST', url: '/api/integrity/1/retry/1',
      })).statusCode).toBe(400);
      for (const payload of [
        { answer: 45, duration_ms: 1_000 },
        { answer: '   ', duration_ms: 1_000 },
        { answer: 'x'.repeat(2_001), duration_ms: 1_000 },
        { answer: '45', duration_ms: -1 },
        { answer: '45', duration_ms: 1.5 },
        { answer: '45', duration_ms: '1000' },
        { answer: '45', duration_ms: 1_000, hint_used: 'да' },
      ]) {
        expect((await app.inject({
          method: 'POST', url: '/api/integrity/1/retry/1', payload,
        })).statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('отдаёт результат повтора и превращает предметную ошибку в 409', async () => {
    const completed = { status: 'completed', result: { runId: 1, correct: 12 } } as const;
    const retry = vi.fn(() => completed);
    const success = Fastify();
    registerIntegrityRoutes(success, {
      coordinator: coordinatorStub({ status: 'checking', flagged: 1 }, retry),
    });
    await success.ready();
    const conflict = Fastify();
    registerIntegrityRoutes(conflict, { coordinator: coordinatorStub(null) });
    await conflict.ready();
    try {
      const response = await success.inject({
        method: 'POST', url: '/api/integrity/1/retry/2',
        payload: { answer: '45', duration_ms: 8_000, hint_used: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(completed);
      expect(retry).toHaveBeenCalledWith(1, 2, '45', 8_000, true);

      const rejected = await conflict.inject({
        method: 'POST', url: '/api/integrity/1/retry/2',
        payload: { answer: '45', duration_ms: 8_000 },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual({ error: 'Повтор сейчас не ожидается' });
    } finally {
      await success.close();
      await conflict.close();
    }
  });

  it('отдаёт 503 при отвязанной базе и в недоступном сервере', async () => {
    const detached = Fastify();
    registerIntegrityRoutes(detached, {
      coordinator: coordinatorStub(null),
      available: () => false,
    });
    await detached.ready();
    const unavailable = Fastify();
    registerUnavailableIntegrity(unavailable, 'база не открылась');
    await unavailable.ready();
    try {
      for (const app of [detached, unavailable]) {
        expect((await app.inject({ method: 'GET', url: '/api/integrity/1' })).statusCode).toBe(503);
        expect((await app.inject({
          method: 'POST', url: '/api/integrity/1/retry/1',
          payload: { answer: '45', duration_ms: 1_000 },
        })).statusCode).toBe(503);
      }
    } finally {
      await detached.close();
      await unavailable.close();
    }
  });
});
