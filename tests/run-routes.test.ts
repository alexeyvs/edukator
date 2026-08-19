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
  let dbPath: string;
  let app: FastifyInstance;
  let db: Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-run-routes-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    dbPath = join(tempDir, 'run-routes.db');

    app = buildServer(curriculumDir, {
      dbPath,
      seedDir,
      now: () => NOW,
      background: (job): void => void job(),
      integrityReview: async (items) => items.map((item) => ({
        id: item.id,
        decision: 'meaningful',
        confidence: 0.99,
        reason: 'Ответ осмысленный.',
      })),
    });
    await app.ready();
    db = openDatabase(dbPath);
    for (const subject of SUBJECTS) {
      storeTasks(db, `${subject}.a`, Array.from({ length: 12 }, (_, index) => task(subject, index)));
    }
  });

  afterEach(async () => {
    db.close();
    await app.close();
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

  async function finishChecked(runId: number): Promise<Record<string, unknown>> {
    let body = (await app.inject({ method: 'POST', url: `/api/run/${runId}/finish` })).json() as
      Record<string, unknown>;
    for (let index = 0; index < 10 && body['status'] === 'checking'; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      body = (await app.inject({ method: 'GET', url: `/api/integrity/${runId}` })).json() as
        Record<string, unknown>;
    }
    if (body['status'] === 'completed') return body['result'] as Record<string, unknown>;
    if (body['status'] !== undefined) throw new Error('Проверка забега не завершилась');
    return body;
  }

  it('проходит полный HTTP-цикл: план, старт, задание, ответ и финиш', async () => {
    const planResponse = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json() as {
      plan: Array<{ subject: string; topic: { id: string; title: string } }>;
      forecasts: Array<{ subject: string; score: number }>;
      streak: { current: number; best: number; completedToday: boolean };
      gate: {
        day: string; required: number; completed: number; remaining: number;
        learning: { materialId: number | null; required: boolean; passed: boolean };
        automaticUnlocked: boolean;
        override: null;
        unlocked: boolean;
      };
      topics: Array<{
        id: string; title: string; subject: string; bossProgress: number;
        readiness: Record<string, unknown>;
      }>;
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
    expect(plan.gate).toEqual({
      day: '2026-08-08', required: 3, completed: 0, remaining: 3,
      learning: { materialId: null, required: false, passed: false },
      automaticUnlocked: false, override: null, unlocked: false,
    });
    expect(plan.topics).toHaveLength(3);
    expect(plan.topics[0]).toMatchObject({
      id: expect.stringMatching(/\.a$/), title: expect.stringContaining('Тема'),
      subject: expect.stringMatching(/math|russian|english/),
      bossProgress: 0,
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

    const finish = await finishChecked(runId);
    expect(finish).toMatchObject({ runId, total: 12, correct: 12, xp: 300 });
    expect(db.prepare('SELECT finished_at, total, correct FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: NOW.toISOString(), total: 12, correct: 12 });
  });

  it('восстанавливает ретрай и переводит все его отказы в 4xx', async () => {
    const runId = await start('math');
    const first = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      progress: {
        total: 0,
        correct: 0,
        target: 12,
        done: false,
        lives: { total: 3, remaining: 3, retryAvailable: false },
      },
    });
    const taskId = (first.json() as { task: { id: number } }).task.id;

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { runId, task_id: taskId, answer: '0', hint_used: true },
    });
    expect(wrong.statusCode).toBe(200);
    const attemptId = (wrong.json() as { attempt_id: number }).attempt_id;
    expect(wrong.json()).toMatchObject({
      correct: false,
      progress: {
        total: 1,
        correct: 0,
        done: false,
        lives: { total: 3, remaining: 3, retryAvailable: true },
      },
    });

    const restored = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      task: { id: taskId },
      retry: {
        attempt_id: attemptId,
        previous_answer: '0',
        answer: '45',
        explain: '40 + 5 = 45.',
        joke: 'Пять единиц не спрятались.',
      },
      progress: { lives: { remaining: 3, retryAvailable: true } },
    });
    expect((restored.json() as { retry: Record<string, unknown> }).retry)
      .not.toHaveProperty('dispute_status');

    const russianRun = await start('russian');
    const russianNext = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${russianRun}`,
    });
    const foreignTaskId = (russianNext.json() as { task: { id: number } }).task.id;
    const foreignAnswer = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: {
        runId,
        task_id: foreignTaskId,
        answer: '45',
        retry_attempt_id: attemptId,
      },
    });
    expect(foreignAnswer.statusCode).toBe(409);
    expect(foreignAnswer.json()).toMatchObject({ code: 'task-not-in-run' });
    const foreignSkip = await app.inject({
      method: 'POST',
      url: '/api/session/retry/skip',
      payload: { runId, task_id: foreignTaskId },
    });
    expect(foreignSkip.statusCode).toBe(409);
    expect(foreignSkip.json()).toMatchObject({ code: 'task-not-in-run' });

    const triageId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES ('math', 'triage', 'math.a', ?)`,
    ).run(NOW.toISOString()).lastInsertRowid);
    const unusual = await app.inject({
      method: 'POST',
      url: '/api/session/retry/skip',
      payload: { runId: triageId, task_id: taskId },
    });
    expect(unusual.statusCode).toBe(409);
    expect(unusual.json()).toMatchObject({ code: 'task-not-in-run' });

    db.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(attemptId);
    const disputed = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    expect(disputed.json()).toMatchObject({ retry: { dispute_status: 'open' } });
    for (const response of [
      await app.inject({
        method: 'POST',
        url: '/api/session/retry/skip',
        payload: { runId, task_id: taskId },
      }),
      await app.inject({
        method: 'POST',
        url: '/api/session/answer',
        payload: { runId, task_id: taskId, answer: '45', retry_attempt_id: attemptId },
      }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'run-not-ready' });
    }

    db.prepare('DELETE FROM disputes WHERE attempt_id = ?').run(attemptId);
    const corrected = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: {
        runId,
        task_id: taskId,
        answer: '45',
        retry_attempt_id: attemptId,
        hint_used: false,
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      correct: true,
      xp: 20,
      progress: {
        total: 1,
        correct: 1,
        lives: { total: 3, remaining: 2, retryAvailable: false },
      },
    });
    expect(db.prepare(
      'SELECT COUNT(*) AS versions, SUM(is_current) AS current FROM attempts WHERE task_id = ?',
    ).get(taskId)).toEqual({ versions: 2, current: 1 });

    const second = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    const secondTaskId = (second.json() as { task: { id: number } }).task.id;
    const secondWrong = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { runId, task_id: secondTaskId, answer: '0' },
    });
    expect(secondWrong.statusCode).toBe(200);
    const skipped = await app.inject({
      method: 'POST',
      url: '/api/session/retry/skip',
      payload: { runId, task_id: secondTaskId },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({
      progress: {
        total: 2,
        correct: 1,
        done: false,
        lives: { total: 3, remaining: 2, retryAvailable: false },
      },
    });

    const third = await app.inject({
      method: 'GET',
      url: `/api/session/next?runId=${runId}`,
    });
    const thirdTaskId = (third.json() as { task: { id: number } }).task.id;
    const thirdWrong = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { runId, task_id: thirdTaskId, answer: '0' },
    });
    const thirdAttemptId = (thirdWrong.json() as { attempt_id: number }).attempt_id;
    db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(NOW.toISOString(), runId);
    for (const response of [
      await app.inject({
        method: 'POST',
        url: '/api/session/retry/skip',
        payload: { runId, task_id: thirdTaskId },
      }),
      await app.inject({
        method: 'POST',
        url: '/api/session/answer',
        payload: {
          runId,
          task_id: thirdTaskId,
          answer: '45',
          retry_attempt_id: thirdAttemptId,
        },
      }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'run-finished' });
    }
  });

  it('отвечает 400 на небезопасные и кривые retry-идентификаторы', async () => {
    for (const payload of [
      {},
      { runId: 1, task_id: '2' },
      { runId: Number.MAX_SAFE_INTEGER + 1, task_id: 2 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/session/retry/skip',
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: 1, answer: '45', retry_attempt_id: Number.MAX_SAFE_INTEGER + 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('отдаёт состояние доступа и оставляет в плане только незакрытые слоты', async () => {
    const insert = db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
       VALUES (?, 'run', ?, ?, ?, '{}')`,
    );
    insert.run('math', 'math.a', '2026-08-08T07:00:00.000Z', '2026-08-08T08:00:00.000Z');
    insert.run('russian', 'russian.a', '2026-08-08T09:00:00.000Z', '2026-08-08T10:00:00.000Z');

    const plan = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      gate: { completed: 2, remaining: 1, unlocked: false },
      plan: [{ subject: 'english' }],
    });
    const status = await app.inject({ method: 'GET', url: '/api/gate/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      day: '2026-08-08', required: 3, completed: 2, remaining: 1,
      learning: { materialId: null, required: false, passed: false },
      automaticUnlocked: false, override: null, unlocked: false,
    });
    expect((plan.json() as { gate: unknown }).gate).toEqual(status.json());

    insert.run('english', 'english.a', '2026-08-08T10:30:00.000Z', '2026-08-08T11:00:00.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/run/plan' })).json()).toMatchObject({
      gate: { completed: 3, remaining: 0, unlocked: true },
      plan: [],
    });
  });

  it('показывает вчерашний незавершённый обычный забег с прогрессом как оставшийся слот', async () => {
    const runId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES ('math', 'run', 'math.a', ?)`,
    ).run('2026-08-07T08:00:00.000Z').lastInsertRowid);
    db.prepare('UPDATE runs SET total = 7, correct = 4, lives_remaining = 1 WHERE id = ?').run(runId);

    const response = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { plan: Array<{ active?: unknown; subject: string }> };
    expect(body.plan).toHaveLength(3);
    expect(body.plan[0]).toMatchObject({
      subject: 'math',
      active: {
        runId,
        startedAt: '2026-08-07T08:00:00.000Z',
        progress: {
          total: 7,
          correct: 4,
          target: 12,
          done: false,
          lives: { total: 3, remaining: 1, retryAvailable: false },
        },
      },
    });
  });

  it('не скрывает активные забеги после выполнения дневной нормы', async () => {
    const finish = db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
       VALUES (?, 'run', ?, ?, ?, '{}')`,
    );
    for (const [subject, hour] of [['math', '08'], ['russian', '09'], ['english', '10']] as const) {
      finish.run(
        subject,
        `${subject}.a`,
        `2026-08-08T${hour}:00:00.000Z`,
        `2026-08-08T${hour}:30:00.000Z`,
      );
    }
    const active = db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES (?, 'run', ?, ?)`,
    );
    const older = Number(active.run('math', 'math.a', '2026-08-06T08:00:00.000Z').lastInsertRowid);
    const newer = Number(active.run('english', 'english.a', '2026-08-07T08:00:00.000Z').lastInsertRowid);

    const response = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      gate: { remaining: number };
      plan: Array<{ active?: { runId: number } }>;
    };
    expect(body.gate.remaining).toBe(0);
    expect(body.plan.map((item) => item.active?.runId)).toEqual([newer, older]);
  });

  it('засчитывает завершённый сегодня перенесённый забег в сегодняшний план', async () => {
    const runId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES ('math', 'run', 'math.a', ?)`,
    ).run('2026-08-07T08:00:00.000Z').lastInsertRowid);
    for (let index = 0; index < 12; index += 1) {
      const next = await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` });
      const taskId = (next.json() as { task: { id: number } }).task.id;
      const answer = await app.inject({
        method: 'POST',
        url: '/api/session/answer',
        payload: { runId, task_id: taskId, answer: '45' },
      });
      expect(answer.statusCode).toBe(200);
    }

    await finishChecked(runId);
    const plan = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect(plan.json()).toMatchObject({ gate: { completed: 1, remaining: 2 } });
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
    expect((await app.inject({
      method: 'POST', url: '/api/run/start', payload: { subject: 'math', topic_id: 42 },
    })).statusCode).toBe(400);
    const staleCard = await app.inject({
      method: 'POST',
      url: '/api/run/start',
      payload: { subject: 'math', topic_id: 'russian.a' },
    });
    expect(staleCard.statusCode).toBe(409);
    expect(staleCard.json()).toMatchObject({ code: 'run-topic-unavailable' });
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
