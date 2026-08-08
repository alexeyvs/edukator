import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { buildServer } from '../server/index.js';
import { registerRunRoutes, registerUnavailableRun } from '../server/routes/run.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(
      join(dir, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: [
          {
            id: `${subject}.a`,
            subject,
            title: `Тема ${subject}`,
            exam_weight: 3,
            difficulty: 2,
            prereqs: [],
            answer_format: 'number',
            prompt_seed: `Спрашивай по теме ${subject}.`,
          },
        ],
      }),
    );
  }
}

function task(subject: string, index = 0): GeneratedTask {
  return {
    instruction: `Вычисли сумму (${subject}, ${index}).`,
    material: '40 + 5',
    material_format: 'math',
    choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Раздели число на десятки и единицы. Сложи части и проверь результат обратным действием.',
    explain: '40 + 5 = 45.',
    joke: 'Пять единиц не спрятались.',
    difficulty: 2,
  };
}

describe('маршруты забега', () => {
  let tempDir: string;
  let curriculumDir: string;
  let seedDir: string;
  let app: FastifyInstance;
  let db: Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-run-routes-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    process.env.EDUKATOR_DB = join(tempDir, 'run-routes.db');

    app = buildServer(curriculumDir, { seedDir, now: () => NOW });
    await app.ready();
    db = openDatabase(process.env.EDUKATOR_DB);
    for (const subject of SUBJECTS) {
      storeTasks(db, `${subject}.a`, Array.from({ length: 12 }, (_, index) => task(subject, index)));
    }
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function start(subject: string): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/run/start',
      payload: { subject },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { runId: number }).runId;
  }

  it('проходит полный HTTP-цикл: план, старт, задание, ответ и финиш', async () => {
    const planResponse = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json() as {
      plan: Array<{ subject: string; topic: { id: string; title: string } }>;
      forecasts: Array<{ subject: string; score: number }>;
      streak: { current: number; best: number; completedToday: boolean };
      topics: Array<{ id: string; title: string; subject: string; readiness: Record<string, unknown> }>;
    };
    expect(plan.plan).toHaveLength(3);
    expect(new Set(plan.plan.map((item) => item.subject))).toEqual(new Set(SUBJECTS));
    expect(plan.plan[0]?.topic).toEqual({
      id: expect.stringMatching(/\.a$/),
      title: expect.stringContaining('Тема'),
    });
    expect(plan.forecasts.map((item) => item.subject)).toEqual(SUBJECTS);
    expect(plan.forecasts.every((item) => item.score === 2)).toBe(true);
    expect(plan.streak).toEqual({ current: 0, best: 0, completedToday: false });
    expect(plan.topics).toHaveLength(3);
    expect(plan.topics[0]).toMatchObject({
      id: expect.stringMatching(/\.a$/), title: expect.stringContaining('Тема'),
      subject: expect.stringMatching(/math|russian|english/),
      readiness: { status: 'working', eligible: false },
    });
    expect(JSON.stringify(plan.topics)).not.toContain('mastery');

    const runId = await start('math');
    for (let index = 0; index < 12; index += 1) {
      const next = await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` });
      expect(next.statusCode).toBe(200);
      const issued = next.json() as { task: Record<string, unknown> & { id: number; subject: string } };
      expect(issued.task.subject).toBe('math');
      expect(issued.task).toMatchObject({
        instruction: expect.stringContaining('Вычисли сумму'),
        material: '40 + 5',
        material_format: 'math',
        choices: [],
        answer_format: 'number',
      });
      const answer = await app.inject({
        method: 'POST',
        url: '/api/session/answer',
        payload: { task_id: issued.task.id, answer: '45', runId, hint_used: false },
      });
      expect(answer.statusCode).toBe(200);
    }

    const beyondTarget = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    expect(beyondTarget.statusCode).toBe(409);
    expect(beyondTarget.json()).toMatchObject({ code: 'run-complete' });

    const finish = await app.inject({ method: 'POST', url: `/api/run/${runId}/finish` });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ runId, total: 12, correct: 12, xp: 300 });
    expect(db.prepare('SELECT finished_at, total, correct FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: NOW.toISOString(), total: 12, correct: 12 });
  });

  it('переводит доменные отказы в 404/409 и не пишет чужую попытку', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/session/next?runId=4242' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'run-not-found' });
    const missingFinish = await app.inject({ method: 'POST', url: '/api/run/4242/finish' });
    expect(missingFinish.statusCode).toBe(404);
    expect(missingFinish.json()).toMatchObject({ code: 'run-not-found' });

    const mathRun = await start('math');
    const russianRun = await start('russian');
    const next = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${russianRun}`,
    });
    const taskId = (next.json() as { task: { id: number } }).task.id;
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: taskId, answer: '45', runId: mathRun },
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toMatchObject({ code: 'task-not-in-run' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE task_id = ?').get(taskId))
      .toEqual({ count: 0 });

    const premature = await app.inject({ method: 'POST', url: `/api/run/${mathRun}/finish` });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toMatchObject({ code: 'run-not-ready' });

    const bossRun = Number(db.prepare(
      "INSERT INTO runs (subject, kind, topic_id, started_at) VALUES (?, 'boss', ?, ?)",
    ).run('math', 'math.a', NOW.toISOString()).lastInsertRowid);
    const bossFinish = await app.inject({ method: 'POST', url: `/api/run/${bossRun}/finish` });
    expect(bossFinish.statusCode).toBe(409);
    expect(bossFinish.json()).toMatchObject({
      code: 'run-not-ready',
      error: expect.stringMatching(/только победой/u),
    });

    db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(NOW.toISOString(), mathRun);
    const afterClose = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${mathRun}`,
    });
    expect(afterClose.statusCode).toBe(409);
    expect(afterClose.json()).toMatchObject({ code: 'run-finished' });
    const finishAgain = await app.inject({ method: 'POST', url: `/api/run/${mathRun}/finish` });
    expect(finishAgain.statusCode).toBe(409);
    expect(finishAgain.json()).toMatchObject({ code: 'run-finished' });
  });

  it('отвергает битые параметры до вызова логики забега', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/run/start', payload: {} })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/run/start', payload: { subject: 'art' } })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/run/nope/finish' })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/run/0/finish' })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/run/999999999999999999999/finish' })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/session/next?runId=nope' })).statusCode)
      .toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });

  it('отдаёт 503 на всех URL, когда соединение отвязано или занятие не поднялось', async () => {
    const detached = Fastify();
    registerRunRoutes(detached, {
      db,
      graph: loadCurriculum(curriculumDir),
      available: () => false,
    });
    await detached.ready();

    const unavailable = Fastify();
    registerUnavailableRun(unavailable, 'база недоступна');
    await unavailable.ready();
    try {
      for (const instance of [detached, unavailable]) {
        expect((await instance.inject({ method: 'GET', url: '/api/run/plan' })).statusCode)
          .toBe(503);
        expect((await instance.inject({ method: 'POST', url: '/api/run/start' })).statusCode)
          .toBe(503);
        expect((await instance.inject({ method: 'POST', url: '/api/run/1/finish' })).statusCode)
          .toBe(503);
      }
    } finally {
      await detached.close();
      await unavailable.close();
    }
  });
});
