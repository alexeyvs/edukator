import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { openDatabase, SUBJECTS, type Subject } from '../server/db.js';
import { startTenantServer, type TenantServer } from './server-harness.js';
import {
  registerTriageRoutes,
  registerUnavailableTriage,
} from '../server/routes/triage.js';
import { fakeContext } from './tenant-context-helper.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(
      join(dir, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: Array.from({ length: 3 }, (_, index) => ({
          id: `${subject}.${index + 1}`,
          subject,
          title: `Тема ${subject} ${index + 1}`,
          exam_weight: 3,
          difficulty: 2,
          prereqs: [],
          answer_format: 'number',
          prompt_seed: `Спрашивай по теме ${subject} ${index + 1}.`,
        })),
      }),
    );
  }
}

function task(subject: Subject, topic: number, difficulty: number): GeneratedTask {
  return {
    instruction: `Задание ${subject} ${topic} сложности ${difficulty}: вычисли сумму.`,
    material: `${difficulty} + 1`,
    material_format: 'math',
    choices: [],
    answer: String(difficulty + 1),
    accept: [String(difficulty + 1)],
    hint: 'Определи первое слагаемое. Прибавь единицу и проверь результат обратным действием.',
    explain: `${difficulty} + 1 = ${difficulty + 1}.`,
    joke: 'Диагностическая лесенка держится.',
    difficulty,
  };
}

describe('маршруты триажа', () => {
  let tempDir: string;
  let curriculumDir: string;
  let seedDir: string;
  let server: TenantServer;
  let app: FastifyInstance;
  let db: Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-triage-routes-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      curriculumDir,
      seedDir,
      now: () => NOW,
    });
    app = server.app;
    db = openDatabase(server.dbPath);
    for (const subject of SUBJECTS) {
      for (let topicNumber = 1; topicNumber <= 3; topicNumber += 1) {
        storeTasks(db, `${subject}.${topicNumber}`, [1, 2, 3].map(
          (difficulty) => task(subject, topicNumber, difficulty),
        ));
      }
    }
  });

  afterEach(async () => {
    db.close();
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startTriage(subject: Subject = 'math'): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/triage/start',
      payload: { subject },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { runId: number }).runId;
  }

  it('выдаёт задания лесенкой без подсказки и отмечает закрытый триаж в плане', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: Array<{ subject: Subject; triagePassed: boolean }>;
      triage: Array<{ subject: Subject; passed: boolean; needed: boolean }>;
    };
    expect(before.plan.every((item) => item.triagePassed === false)).toBe(true);
    expect(before.triage.every((item) => item.passed === false)).toBe(true);
    expect(before.triage.every((item) => item.needed)).toBe(true);

    const runId = await startTriage();
    const firstResponse = await app.inject({
      method: 'GET',
      url: `/api/triage/${runId}/next`,
    });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json() as {
      status: string;
      task: Record<string, unknown> & { id: number; difficulty: number; topic_id: string };
    };
    expect(first).toMatchObject({
      status: 'ok',
      task: {
        difficulty: 2,
        subject: 'math',
        answer_format: 'number',
        instruction: expect.stringContaining('вычисли сумму'),
        material: '2 + 1',
        material_format: 'math',
        choices: [],
      },
    });
    expect(first.task).not.toHaveProperty('hint');
    expect(first.task).not.toHaveProperty('deep_hint');

    const answer = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: first.task.id, answer: '3', runId },
    });
    expect(answer.statusCode).toBe(200);

    const second = (await app.inject({
      method: 'GET',
      url: `/api/triage/${runId}/next`,
    })).json() as { task: { id: number; difficulty: number; topic_id: string } };
    expect(second.task.difficulty).toBe(3);
    expect(second.task.topic_id).not.toBe(first.task.topic_id);

    await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: second.task.id, answer: '4', runId },
    });
    const third = (await app.inject({
      method: 'GET',
      url: `/api/triage/${runId}/next`,
    })).json() as { task: { id: number } };
    await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: third.task.id, answer: '4', runId },
    });
    expect((await app.inject({ method: 'GET', url: `/api/triage/${runId}/next` })).json())
      .toMatchObject({ status: 'done', total: 3 });

    const finish = await app.inject({ method: 'POST', url: `/api/run/${runId}/finish` });
    expect(finish.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: Array<{ subject: Subject; triagePassed: boolean }>;
      triage: Array<{ subject: Subject; passed: boolean; needed: boolean }>;
    };
    expect(after.triage.find((item) => item.subject === 'math')?.passed).toBe(true);
    expect(after.triage.find((item) => item.subject === 'math')?.needed).toBe(false);
    expect(after.triage.filter((item) => item.subject !== 'math').every(
      (item) => item.passed === false && item.needed,
    )).toBe(true);
  });

  it('не засчитывает как пройденный брошенный вчерашний триаж', async () => {
    const abandoned = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES (?, 'triage', ?, ?)`,
    ).run('math', 'math.1', '2026-08-07T12:00:00.000Z').lastInsertRowid);

    await startTriage('russian');

    expect(db.prepare('SELECT finished_at, summary FROM runs WHERE id = ?').get(abandoned))
      .toEqual({ finished_at: '2026-08-07T12:00:00.000Z', summary: null });
    const plan = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: Array<{ subject: Subject; triagePassed: boolean }>;
      triage: Array<{ subject: Subject; passed: boolean; needed: boolean }>;
    };
    expect(plan.plan.find((item) => item.subject === 'math')?.triagePassed).toBe(false);
    expect(plan.triage.find((item) => item.subject === 'math')?.passed).toBe(false);
    expect(plan.triage.find((item) => item.subject === 'math')?.needed).toBe(true);
  });

  it('возвращает завершение, когда диагностические темы исчерпаны', async () => {
    const runId = await startTriage('english');
    db.prepare("UPDATE task_bank SET status = 'rejected' WHERE topic_id LIKE 'english.%'").run();

    expect((await app.inject({
      method: 'GET',
      url: `/api/triage/${runId}/next`,
    })).json()).toEqual({ status: 'done', total: 0, target: 12 });
  });

  it('отвергает неизвестный, закрытый и обычный забег', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/triage/4242/next' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'run-not-found' });

    const ordinary = await app.inject({
      method: 'POST',
      url: '/api/run/start',
      payload: { subject: 'russian' },
    });
    const ordinaryId = (ordinary.json() as { runId: number }).runId;
    const wrongKind = await app.inject({
      method: 'GET',
      url: `/api/triage/${ordinaryId}/next`,
    });
    expect(wrongKind.statusCode).toBe(409);
    expect(wrongKind.json()).toMatchObject({ code: 'task-not-in-run' });

    const triageId = await startTriage();
    const premature = await app.inject({ method: 'POST', url: `/api/run/${triageId}/finish` });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toMatchObject({ code: 'run-not-ready' });
    db.prepare("UPDATE task_bank SET status = 'rejected' WHERE topic_id LIKE 'math.%'").run();
    expect((await app.inject({ method: 'POST', url: `/api/run/${triageId}/finish` })).statusCode)
      .toBe(200);
    const closed = await app.inject({ method: 'GET', url: `/api/triage/${triageId}/next` });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: 'run-finished' });
  });

  it('отвергает битые параметры и отдаёт 503 при недоступном занятии', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/triage/start', payload: {} })).statusCode)
      .toBe(400);
    expect((await app.inject({
      method: 'POST',
      url: '/api/triage/start',
      payload: { subject: 'art' },
    })).statusCode).toBe(400);
    for (const id of ['nope', '0', '999999999999999999999']) {
      expect((await app.inject({ method: 'GET', url: `/api/triage/${id}/next` })).statusCode)
        .toBe(400);
    }

    const detached = Fastify();
    registerTriageRoutes(detached, {
      context: fakeContext(db, { available: () => false }),
    });
    await detached.ready();
    const unavailable = Fastify();
    registerUnavailableTriage(unavailable, 'база недоступна');
    await unavailable.ready();
    try {
      for (const instance of [detached, unavailable]) {
        expect((await instance.inject({ method: 'POST', url: '/api/triage/start' })).statusCode)
          .toBe(503);
        expect((await instance.inject({ method: 'GET', url: '/api/triage/1/next' })).statusCode)
          .toBe(503);
      }
    } finally {
      await detached.close();
      await unavailable.close();
    }
  });
});
