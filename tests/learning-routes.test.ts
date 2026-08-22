import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { startTenantServer, type TenantServer } from './server-harness.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { claimLearningMaterial, LEARNING_PASS_SCORE } from '../server/learning.js';
import { reserveBossTasks, reserveLearningTasks, storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { readStreak } from '../server/streak.js';
import { registerLearningRoutes, registerUnavailableLearning } from '../server/routes/learning.js';
import { loadCurriculum } from '../server/curriculum.js';
import { resolveDispute } from '../server/session.js';
import { fakeContext } from './tenant-context-helper.js';
import { createDraft, publishRevision } from '../server/course-catalog.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');

const CONTENT = {
  introduction: 'Дроби описывают части целого без лишней магии.',
  objectives: ['Складывать дроби с одинаковыми знаменателями'],
  sections: [
    { title: 'Числитель', blocks: [{ type: 'paragraph', content: 'Сверху записано число выбранных частей.' }] },
    { title: 'Знаменатель', blocks: [{ type: 'formula', content: '\\frac{a}{b}' }] },
    { title: 'Сложение', blocks: [{ type: 'example', content: 'Одна четверть плюс две четверти — три четверти.' }] },
  ],
  summary: ['Знаменатель описывает размер частей.', 'При равных знаменателях складываются числители.'],
} as const;

function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(join(dir, `${subject}.json`), JSON.stringify({
      subject,
      topics: [{
        id: `${subject}.a`, subject, title: `Тема ${subject}`, exam_weight: 3,
        difficulty: 2, prereqs: [], answer_format: 'number',
        prompt_seed: `Проверяй понимание темы ${subject}`,
      }],
    }));
  }
}

function task(label: string, index: number): GeneratedTask {
  return {
    instruction: `Вопрос ${label}-${index}: сколько будет два плюс два?`,
    material: '', material_format: 'none', choices: [], answer: '4', accept: ['4'],
    hint: 'Сложи по единице.', explain: '2 + 2 = 4.', joke: 'Четвёрка на месте.', difficulty: 2,
  };
}

describe('Learning API', () => {
  let tempDir: string;
  let curriculumDir: string;
  let seedDir: string;
  let server: TenantServer;
  let app: FastifyInstance;
  let db: Database;
  let serial: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-learning-routes-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    serial = 0;
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      curriculumDir,
      seedDir,
      now: () => NOW,
      review: async () => {
        throw new Error('проверяющий временно недоступен');
      },
      background: (job): void => void job(),
      log: (): void => undefined,
    });
    app = server.app;
    db = openDatabase(server.dbPath);
    for (const subject of SUBJECTS) {
      const revisionId = server.control.prepare<[string], { active_revision_id: number }>(
        'SELECT active_revision_id FROM courses WHERE id = ?',
      ).get(subject)?.active_revision_id;
      storeTasks(db, `${subject}.a`, Array.from({ length: 12 }, (_, index) =>
        task(`обычный-${subject}`, index)), { courseRevisionId: revisionId ?? null });
    }
  });

  afterEach(async () => {
    db.close();
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readyMaterial(subject = 'math'): { materialId: number; taskIds: number[] } {
    serial += 1;
    const mastery = db.prepare<[string], { mastery: number }>(
      'SELECT mastery FROM topic_state WHERE topic_id = ?',
    ).get(`${subject}.a`)?.mastery ?? 0;
    const claim = claimLearningMaterial(db, {
      subject, topicId: `${subject}.a`, recommendationReason: 'Ошибки со знаменателями',
      masteryBefore: mastery, estimatedMinutes: 12, now: NOW,
      courseRevisionId: server.control.prepare<[string], { active_revision_id: number }>(
        'SELECT active_revision_id FROM courses WHERE id = ?',
      ).get(subject)?.active_revision_id ?? null,
    });
    if (claim === undefined) throw new Error('material claim не создан');
    const reserved = reserveLearningTasks(
      db,
      claim.materialId,
      CONTENT,
      Array.from({ length: 5 }, (_, index) => task(`материал-${serial}`, index)),
      NOW,
    );
    if (!reserved.ready) throw new Error('material не опубликован');
    return { materialId: claim.materialId, taskIds: reserved.stored.map(({ id }) => id) };
  }

  function publishNextRevision(subject: string): void {
    const active = server.control.prepare<[string], { active_revision_id: number }>(
      'SELECT active_revision_id FROM courses WHERE id = ?',
    ).get(subject)?.active_revision_id;
    if (active === undefined) throw new Error(`Нет активной редакции ${subject}`);
    const draft = createDraft(server.control, subject, active);
    publishRevision(server.control, subject, draft.id, draft.editVersion);
  }

  async function openAndStart(materialId: number): Promise<number> {
    expect((await app.inject({ method: 'POST', url: `/api/learning/${materialId}/open` })).statusCode)
      .toBe(200);
    const response = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(response.statusCode).toBe(200);
    return (response.json() as { runId: number }).runId;
  }

  async function answerFive(runId: number, correct: number): Promise<number[]> {
    const attempts: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` });
      expect(next.statusCode).toBe(200);
      const body = next.json() as {
        task: { id: number; hint?: string };
        progress: { total: number; correct: number; target: number; done: boolean };
      };
      expect(body.task).not.toHaveProperty('hint');
      expect(body.task).not.toHaveProperty('deep_hint');
      expect(body.progress).toMatchObject({ total: index, target: 5, done: false });
      const response = await app.inject({
        method: 'POST', url: '/api/session/answer',
        payload: {
          task_id: body.task.id, runId, answer: index < correct ? '4' : '5',
          hint_used: false, duration_ms: 1000 + index,
        },
      });
      expect(response.statusCode).toBe(200);
      attempts.push((response.json() as { attempt_id: number }).attempt_id);
    }
    return attempts;
  }

  async function finishLearningCompleted(runId: number) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: `/api/learning/run/${runId}/finish`,
      });
      if ((response.json() as { status?: string }).status !== 'checking') return response;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Проверка lesson-run ${runId} не завершилась`);
  }

  it('показывает только готовую карточку и безопасно открывает материал', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect((empty.json() as { learning: unknown[] }).learning).toEqual([]);
    const { materialId } = readyMaterial();

    const plan = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect((plan.json() as { learning: unknown[] }).learning).toMatchObject([{
      id: materialId, subject: 'math', topic: { id: 'math.a', title: 'Тема math' },
      recommendationReason: 'Ошибки со знаменателями', estimatedMinutes: 12, status: 'ready',
    }]);

    const detail = await app.inject({ method: 'GET', url: `/api/learning/${materialId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: materialId, status: 'ready', content: CONTENT,
      passScore: 4,
      progress: { total: 0, correct: 0, target: 5, done: false },
    });
    expect(JSON.stringify(detail.json())).not.toMatch(/answer|accept|hint/iu);

    const first = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/open` });
    const second = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/open` });
    expect(first.json()).toMatchObject({ materialId, resumed: false, material: { status: 'active' } });
    expect(second.json()).toMatchObject({ materialId, resumed: true, material: { status: 'active' } });
    expect((await app.inject({ method: 'GET', url: '/api/run/plan' })).json())
      .toMatchObject({ learning: [{ id: materialId, status: 'active' }] });
  });

  it('не выдаёт материал старой редакции, но продолжает уже начатый lesson-run', async () => {
    const staleReady = readyMaterial('math');
    const started = readyMaterial('russian');
    const runId = await openAndStart(started.materialId);

    publishNextRevision('math');
    publishNextRevision('russian');

    const plan = await app.inject({ method: 'GET', url: '/api/run/plan' });
    expect((plan.json() as { learning: Array<{ id: number }> }).learning)
      .not.toContainEqual(expect.objectContaining({ id: staleReady.materialId }));
    for (const suffix of ['', '/open', '/test']) {
      const response = await app.inject({
        method: suffix === '' ? 'GET' : 'POST',
        url: `/api/learning/${staleReady.materialId}${suffix}`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'learning-not-ready' });
    }

    const continued = await app.inject({ method: 'GET', url: `/api/learning/${started.materialId}` });
    expect(continued.statusCode).toBe(200);
    const resumed = await app.inject({ method: 'POST', url: `/api/learning/${started.materialId}/test` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ runId, resumed: true });
  });

  it('создаёт один lesson-run, сохраняет порядок и не меняет обычный план', async () => {
    const { materialId, taskIds } = readyMaterial();
    const before = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: Array<{ subject: string }>;
    };
    const premature = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toMatchObject({ code: 'learning-not-ready' });

    await app.inject({ method: 'POST', url: `/api/learning/${materialId}/open` });
    const first = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    const second = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(first.json()).toMatchObject({ materialId, resumed: false, progress: { target: 5 } });
    expect(second.json()).toMatchObject({
      materialId, runId: (first.json() as { runId: number }).runId, resumed: true,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE kind = 'lesson'").get())
      .toEqual({ count: 1 });

    const runId = (first.json() as { runId: number }).runId;
    const after = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: Array<{ subject: string }>;
    };
    expect(after.plan.map(({ subject }) => subject)).toEqual(before.plan.map(({ subject }) => subject));

    const next = await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` });
    expect((next.json() as { task: { id: number } }).task.id).toBe(taskIds[0]);
    const forbiddenHint = await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: taskIds[0], runId, answer: '4', hint_used: true },
    });
    expect(forbiddenHint.statusCode).toBe(409);
    expect(forbiddenHint.json()).toMatchObject({ code: 'task-not-in-run' });
    const outOfOrder = await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: taskIds[1], runId, answer: '4', hint_used: false },
    });
    expect(outOfOrder.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId))
      .toEqual({ count: 0 });

    await answerFive(runId, 5);
    expect(db.prepare(
      `SELECT attempts.task_id FROM attempts WHERE run_id = ? ORDER BY attempts.id`,
    ).all(runId)).toEqual(taskIds.map((task_id) => ({ task_id })));
    expect((await app.inject({ method: 'GET', url: `/api/session/next?runId=${runId}` })).json())
      .toMatchObject({ code: 'run-complete' });
    expect((await app.inject({ method: 'POST', url: `/api/run/${runId}/finish` })).json())
      .toMatchObject({ code: 'run-not-ready' });
  });

  it('после первого ответа не отдаёт теорию и возобновляет существующий тест', async () => {
    const { materialId } = readyMaterial();
    const runId = await openAndStart(materialId);
    const next = (await app.inject({
      method: 'GET', url: `/api/session/next?runId=${runId}`,
    })).json() as { task: { id: number } };
    expect((await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: next.task.id, runId, answer: '4', hint_used: false },
    })).statusCode).toBe(200);

    for (const request of [
      { method: 'GET' as const, url: `/api/learning/${materialId}` },
      { method: 'POST' as const, url: `/api/learning/${materialId}/open` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(request.method === 'GET'
        ? { content: null, progress: { total: 1 } }
        : { resumed: true, material: { content: null, progress: { total: 1 } } });
      expect(response.body).not.toContain(CONTENT.introduction);
    }

    const resumed = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ runId, resumed: true, progress: { total: 1 } });
  });

  it('продолжает lesson-run после победы над боссом, сохраняя запрет обычному забегу', async () => {
    const { materialId } = readyMaterial();
    const lessonRunId = await openAndStart(materialId);
    const lessonFirst = (await app.inject({
      method: 'GET', url: `/api/session/next?runId=${lessonRunId}`,
    })).json() as { task: { id: number } };
    expect((await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: lessonFirst.task.id, runId: lessonRunId, answer: '4', hint_used: false },
    })).statusCode).toBe(200);

    const ordinaryRun = await app.inject({
      method: 'POST', url: '/api/run/start', payload: { subject: 'math' },
    });
    expect(ordinaryRun.statusCode).toBe(200);
    const ordinaryRunId = (ordinaryRun.json() as { runId: number }).runId;
    const ordinaryTask = (await app.inject({
      method: 'GET', url: `/api/session/next?runId=${ordinaryRunId}`,
    })).json() as { task: { id: number } };

    db.prepare('UPDATE topic_state SET mastery = .8 WHERE topic_id = ?').run('math.a');
    const batchId = Number(db.prepare(
      "INSERT INTO boss_batches (topic_id, course_revision_id, status) VALUES (?, ?, 'preparing')",
    ).run('math.a', server.control.prepare<[string], { active_revision_id: number }>(
      'SELECT active_revision_id FROM courses WHERE id = ?',
    ).get('math')?.active_revision_id ?? null).lastInsertRowid);
    expect(reserveBossTasks(
      db,
      batchId,
      Array.from({ length: 5 }, (_, index) => task('босс', index)),
    ).ready).toBe(true);
    const bossStart = await app.inject({
      method: 'POST', url: '/api/boss/start', payload: { topic_id: 'math.a' },
    });
    expect(bossStart.statusCode).toBe(200);
    const bossRunId = (bossStart.json() as { runId: number }).runId;
    for (let position = 1; position <= 5; position += 1) {
      const next = (await app.inject({
        method: 'GET', url: `/api/boss/${bossRunId}/next`,
      })).json() as { task: { id: number } };
      const answer = await app.inject({
        method: 'POST', url: `/api/boss/${bossRunId}/answer`,
        payload: { task_id: next.task.id, answer: '4', duration_ms: 1000 },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({ outcome: position === 5 ? 'won' : 'active' });
    }
    expect(db.prepare('SELECT closed_at FROM topic_state WHERE topic_id = ?').get('math.a'))
      .toEqual({ closed_at: NOW.toISOString() });

    const ordinaryRejected = await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: ordinaryTask.task.id, runId: ordinaryRunId, answer: '4', hint_used: false },
    });
    expect(ordinaryRejected.statusCode).toBe(409);
    expect(ordinaryRejected.json()).toMatchObject({ code: 'task-not-in-run' });

    const planAfterBoss = (await app.inject({ method: 'GET', url: '/api/run/plan' })).json() as {
      plan: unknown[];
    };
    for (let position = 2; position <= 5; position += 1) {
      const next = await app.inject({
        method: 'GET', url: `/api/session/next?runId=${lessonRunId}`,
      });
      expect(next.statusCode).toBe(200);
      const body = next.json() as { task: { id: number }; progress: { total: number } };
      expect(body.progress.total).toBe(position - 1);
      expect((await app.inject({
        method: 'POST', url: '/api/session/answer',
        payload: { task_id: body.task.id, runId: lessonRunId, answer: '4', hint_used: false },
      })).statusCode).toBe(200);
    }

    const finish = await finishLearningCompleted(lessonRunId);
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ materialId, outcome: 'passed', total: 5, correct: 5 });
    expect(readStreak(db, NOW)).toEqual({ current: 0, best: 0, completedToday: false });
    expect((await app.inject({ method: 'GET', url: '/api/run/plan' })).json())
      .toMatchObject({ plan: planAfterBoss.plan, learning: [] });
  });

  it.each([
    { correct: 4, outcome: 'passed', xp: 100 },
    { correct: 3, outcome: 'failed', xp: 75 },
  ])('завершает $outcome при $correct/5, пишет прогноз и не продлевает streak', async ({
    correct, outcome, xp,
  }) => {
    expect(LEARNING_PASS_SCORE).toBe(4);
    const { materialId } = readyMaterial();
    const runId = await openAndStart(materialId);
    const beforeMastery = db.prepare<[], { mastery: number }>(
      "SELECT mastery FROM topic_state WHERE topic_id = 'math.a'",
    ).get()?.mastery ?? -1;
    await answerFive(runId, correct);
    const afterAnswers = db.prepare<[], { mastery: number }>(
      "SELECT mastery FROM topic_state WHERE topic_id = 'math.a'",
    ).get()?.mastery ?? -1;
    expect(afterAnswers).not.toBe(beforeMastery);

    const beforeSnapshots = db.prepare(
      "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
    ).get();
    const finish = await finishLearningCompleted(runId);
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({
      materialId, runId, total: 5, correct, xp, outcome,
      passScore: 4, required: true,
      masteryBefore: beforeMastery, masteryAfter: afterAnswers,
      forecast: { subject: 'math' },
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
    ).get()).toEqual({ count: (beforeSnapshots as { count: number }).count + 1 });
    expect(readStreak(db, NOW)).toEqual({ current: 0, best: 0, completedToday: false });
    expect(db.prepare('SELECT status FROM learning_materials WHERE id = ?').get(materialId))
      .toEqual({ status: outcome === 'passed' ? 'passed' : 'active' });

    const restart = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    if (outcome === 'passed') {
      expect(restart.statusCode).toBe(409);
      expect(restart.json()).toMatchObject({ code: 'learning-finished' });
    } else {
      expect(restart.statusCode).toBe(200);
      expect(restart.json()).toMatchObject({ materialId, resumed: false, progress: { total: 0 } });
    }

    const repeated = await finishLearningCompleted(runId);
    expect(repeated.json()).toEqual(finish.json());
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
    ).get()).toEqual({ count: (beforeSnapshots as { count: number }).count + 1 });
  });

  it('повторяет тот же тест до зачёта без повторных XP и mastery и открывает дневной гейт', async () => {
    const { materialId, taskIds } = readyMaterial();
    for (const finishedAt of [
      '2026-08-09T09:00:00.000Z',
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T12:00:00.000Z',
    ]) {
      db.prepare(
        `INSERT INTO runs
           (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
         VALUES ('math', 'run', 'math.a', ?, ?, '{}', 12, 12)`,
      ).run(finishedAt, finishedAt);
    }
    const firstRunId = await openAndStart(materialId);
    await answerFive(firstRunId, 3);
    const masteryAfterFirst = db.prepare<[], { mastery: number; attempts: number }>(
      "SELECT mastery, attempts FROM topic_state WHERE topic_id = 'math.a'",
    ).get();
    const firstFinish = await finishLearningCompleted(firstRunId);
    expect(firstFinish.json()).toMatchObject({ outcome: 'failed', xp: 75 });
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ learning: { materialId, required: true, passed: false }, unlocked: false });

    const reread = await app.inject({ method: 'GET', url: `/api/learning/${materialId}` });
    expect(reread.json()).toMatchObject({
      content: CONTENT,
      progress: { total: 0, correct: 0, target: 5, done: false },
    });
    const retryStart = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(retryStart.statusCode).toBe(200);
    const retryRunId = (retryStart.json() as { runId: number }).runId;
    expect(retryRunId).not.toBe(firstRunId);

    const firstRetryTask = (await app.inject({
      method: 'GET', url: `/api/session/next?runId=${retryRunId}`,
    })).json() as { task: { id: number } };
    expect(firstRetryTask.task.id).toBe(taskIds[0]);
    const firstRetryAnswer = await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: {
        task_id: firstRetryTask.task.id, runId: retryRunId, answer: '4',
        hint_used: false, duration_ms: 1000,
      },
    });
    expect(firstRetryAnswer.json()).toMatchObject({ xp: 0, progress: { total: 1, correct: 1 } });
    const resumed = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
    expect(resumed.json()).toMatchObject({ runId: retryRunId, resumed: true, progress: { total: 1 } });

    for (let index = 1; index < taskIds.length; index += 1) {
      const next = (await app.inject({
        method: 'GET', url: `/api/session/next?runId=${retryRunId}`,
      })).json() as { task: { id: number } };
      expect(next.task.id).toBe(taskIds[index]);
      const answer = await app.inject({
        method: 'POST', url: '/api/session/answer',
        payload: { task_id: next.task.id, runId: retryRunId, answer: '4', hint_used: false },
      });
      expect(answer.json()).toMatchObject({ xp: 0 });
    }
    expect(db.prepare(
      `SELECT learning_runs.run_id, learning_runs.attempt_number, COUNT(attempts.id) AS answers,
              SUM(attempts.affects_progress) AS progress_answers
         FROM learning_runs LEFT JOIN attempts ON attempts.run_id = learning_runs.run_id
        WHERE learning_runs.material_id = ?
        GROUP BY learning_runs.run_id, learning_runs.attempt_number
        ORDER BY learning_runs.attempt_number`,
    ).all(materialId)).toEqual([
      { run_id: firstRunId, attempt_number: 1, answers: 5, progress_answers: 5 },
      { run_id: retryRunId, attempt_number: 2, answers: 5, progress_answers: 0 },
    ]);
    expect(db.prepare("SELECT mastery, attempts FROM topic_state WHERE topic_id = 'math.a'").get())
      .toEqual(masteryAfterFirst);

    const snapshotsBeforeRetryFinish = db.prepare(
      "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
    ).get();
    const retryFinish = await finishLearningCompleted(retryRunId);
    expect(retryFinish.json()).toMatchObject({
      outcome: 'passed', xp: 0,
      masteryBefore: masteryAfterFirst?.mastery, masteryAfter: masteryAfterFirst?.mastery,
      touchedTopics: [],
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'").get())
      .toEqual(snapshotsBeforeRetryFinish);
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ learning: { materialId, required: true, passed: true }, unlocked: true });
    expect((await finishLearningCompleted(firstRunId)).json()).toEqual(firstFinish.json());
  });

  it.each([
    { studentCorrect: true, expectedCorrect: 4, outcome: 'passed', gatePassed: true },
    { studentCorrect: false, expectedCorrect: 3, outcome: 'failed', gatePassed: false },
  ])(
    'изолирует retry-спор от XP/mastery/прогноза при verdict=$studentCorrect',
    async ({ studentCorrect, expectedCorrect, outcome, gatePassed }) => {
      const { materialId } = readyMaterial();
      for (const finishedAt of [
        '2026-08-09T09:00:00.000Z',
        '2026-08-09T10:00:00.000Z',
        '2026-08-09T12:00:00.000Z',
      ]) {
        db.prepare(
          `INSERT INTO runs
            (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
           VALUES ('math', 'run', 'math.a', ?, ?, '{}', 12, 12)`,
        ).run(finishedAt, finishedAt);
      }
      const firstRunId = await openAndStart(materialId);
      await answerFive(firstRunId, 3);
      await finishLearningCompleted(firstRunId);
      const stableMastery = db.prepare<[], { mastery: number; attempts: number }>(
        "SELECT mastery, attempts FROM topic_state WHERE topic_id = 'math.a'",
      ).get();
      const stableForecasts = db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
      ).get()?.count;

      const retry = await app.inject({ method: 'POST', url: `/api/learning/${materialId}/test` });
      const retryRunId = (retry.json() as { runId: number }).runId;
      const retryAttempts = await answerFive(retryRunId, 3);
      const disputedAttempt = retryAttempts[3];
      if (disputedAttempt === undefined) throw new Error('retry-попытка для спора не найдена');
      const dispute = await app.inject({
        method: 'POST', url: '/api/session/dispute', payload: { attempt_id: disputedAttempt },
      });
      const disputeId = (dispute.json() as { dispute_id: number }).dispute_id;

      const resolved = await resolveDispute(
        db,
        loadCurriculum(curriculumDir),
        disputeId,
        () => Promise.resolve({ studentCorrect, note: 'Проверен повтор' }),
      );
      expect(resolved).toMatchObject({
        status: studentCorrect ? 'upheld' : 'rejected', xp: 0, state: null,
        progress: { correct: expectedCorrect },
      });
      expect(await resolveDispute(
        db,
        loadCurriculum(curriculumDir),
        disputeId,
        () => Promise.reject(new Error('повторный review не нужен')),
      )).toMatchObject({
        status: studentCorrect ? 'upheld' : 'rejected', xp: 0, state: null,
        progress: { correct: expectedCorrect },
      });
      expect(db.prepare("SELECT mastery, attempts FROM topic_state WHERE topic_id = 'math.a'").get())
        .toEqual(stableMastery);

      const finish = await finishLearningCompleted(retryRunId);
      expect(finish.json()).toMatchObject({
        materialId, correct: expectedCorrect, outcome, xp: 0, touchedTopics: [], required: true,
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM forecast_snapshots WHERE subject = 'math'",
      ).get()).toEqual({ count: stableForecasts });
      expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
        .toMatchObject({
          learning: { materialId, required: true, passed: gatePassed },
          unlocked: gatePassed,
        });
    },
  );

  it('помечает завершение добровольного материала как необязательное', async () => {
    const russianRevision = server.control.prepare<[string], { active_revision_id: number }>(
      'SELECT active_revision_id FROM courses WHERE id = ?',
    ).get('russian')?.active_revision_id;
    if (russianRevision === undefined) throw new Error('Нет редакции русского курса');
    db.prepare(
      `INSERT INTO learning_materials
        (subject, topic_id, course_revision_id, status, recommendation_reason, mastery_before,
         created_at, updated_at, ready_at, finished_at)
       VALUES ('russian', 'russian.a', ?, 'retired', 'Снятый первый разбор', 0.2,
               ?, ?, ?, ?)`,
    ).run(
      russianRevision,
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T10:30:00.000Z',
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T10:30:00.000Z',
    );
    const { materialId } = readyMaterial();
    const runId = await openAndStart(materialId);
    await answerFive(runId, 3);

    const finish = await finishLearningCompleted(runId);
    expect(finish.json()).toMatchObject({ materialId, outcome: 'failed', required: false });
  });

  it('не завершает неполный тест и lesson-run с открытым спором', async () => {
    const { materialId } = readyMaterial();
    const runId = await openAndStart(materialId);
    const firstTask = (await app.inject({
      method: 'GET', url: `/api/session/next?runId=${runId}`,
    })).json() as { task: { id: number } };
    const firstAnswer = await app.inject({
      method: 'POST', url: '/api/session/answer',
      payload: { task_id: firstTask.task.id, runId, answer: '5', hint_used: false },
    });
    const wrongAttempt = (firstAnswer.json() as { attempt_id: number }).attempt_id;
    const incomplete = await app.inject({
      method: 'POST', url: `/api/learning/run/${runId}/finish`,
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json()).toMatchObject({ code: 'learning-incomplete' });

    for (let position = 2; position <= 5; position += 1) {
      const next = (await app.inject({
        method: 'GET', url: `/api/session/next?runId=${runId}`,
      })).json() as { task: { id: number } };
      expect((await app.inject({
        method: 'POST', url: '/api/session/answer',
        payload: { task_id: next.task.id, runId, answer: '4', hint_used: false },
      })).statusCode).toBe(200);
    }
    const dispute = await app.inject({
      method: 'POST', url: '/api/session/dispute', payload: { attempt_id: wrongAttempt },
    });
    expect(dispute.statusCode).toBe(202);
    for (const finishedAt of [
      '2026-08-09T09:00:00.000Z',
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T12:00:00.000Z',
    ]) {
      db.prepare(
        `INSERT INTO runs
          (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
         VALUES ('math', 'run', 'math.a', ?, ?, '{}', 12, 12)`,
      ).run(finishedAt, finishedAt);
    }
    const blocked = await app.inject({
      method: 'POST', url: `/api/learning/run/${runId}/finish`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'learning-dispute-open' });
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: null });
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ learning: { materialId, required: true, passed: false }, unlocked: false });

    const disputeId = (dispute.json() as { dispute_id: number }).dispute_id;
    await resolveDispute(db, loadCurriculum(curriculumDir), disputeId, () => Promise.resolve({
      studentCorrect: false,
      note: 'Ответ остаётся ошибочным',
    }));
    const finished = await finishLearningCompleted(runId);
    expect(finished.json()).toMatchObject({ outcome: 'passed', correct: 4 });
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).json())
      .toMatchObject({ learning: { materialId, required: true, passed: true }, unlocked: true });
  });

  it.each([
    { studentCorrect: false, outcome: 'failed', correct: 3 },
    { studentCorrect: true, outcome: 'passed', correct: 4 },
  ])('после $outcome-разрешения спора завершает lesson-run', async ({
    studentCorrect, outcome, correct,
  }) => {
    const { materialId } = readyMaterial();
    const runId = await openAndStart(materialId);
    const attempts = await answerFive(runId, 3);
    const disputedAttempt = attempts[3];
    if (disputedAttempt === undefined) throw new Error('не найдена ошибочная попытка');
    const disputeResponse = await app.inject({
      method: 'POST', url: '/api/session/dispute', payload: { attempt_id: disputedAttempt },
    });
    const disputeId = (disputeResponse.json() as { dispute_id: number }).dispute_id;
    const masteryBeforeResolution = db.prepare<[], { mastery: number }>(
      "SELECT mastery FROM topic_state WHERE topic_id = 'math.a'",
    ).get()?.mastery;

    await resolveDispute(db, loadCurriculum(curriculumDir), disputeId, () => Promise.resolve({
      studentCorrect,
      note: studentCorrect ? 'Ответ ученика допустим' : 'Ответ не совпадает с правилом',
    }));
    expect(db.prepare('SELECT correct FROM runs WHERE id = ?').get(runId)).toEqual({ correct });
    const masteryAfterResolution = db.prepare<[], { mastery: number }>(
      "SELECT mastery FROM topic_state WHERE topic_id = 'math.a'",
    ).get()?.mastery;
    if (studentCorrect) expect(masteryAfterResolution).not.toBe(masteryBeforeResolution);
    else expect(masteryAfterResolution).toBe(masteryBeforeResolution);

    const finish = await finishLearningCompleted(runId);
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ materialId, runId, correct, outcome });
  });

  it('валидирует идентификаторы, состояния и полное безопасное содержимое', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/learning/nope' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/learning/0/open' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/learning/999/test' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/learning/run/nope/finish' })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/learning/999' })).statusCode).toBe(404);

    const { materialId } = readyMaterial();
    db.prepare('UPDATE learning_materials SET content = ? WHERE id = ?')
      .run(JSON.stringify({ ...CONTENT, introduction: '<script>bad()</script>' }), materialId);
    const unsafe = await app.inject({ method: 'GET', url: `/api/learning/${materialId}` });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json()).toMatchObject({ code: 'learning-inconsistent' });
    expect(unsafe.body).not.toContain('<script>');
  });

  it('отдаёт 503 на всех learning URL при отвязанной или неподнятой базе', async () => {
    const detached = Fastify();
    registerLearningRoutes(detached, { context: fakeContext(db, { available: () => false }) });
    await detached.ready();
    const unavailable = Fastify();
    registerUnavailableLearning(unavailable, 'база недоступна');
    await unavailable.ready();
    try {
      for (const instance of [detached, unavailable]) {
        expect((await instance.inject({ method: 'GET', url: '/api/learning/1' })).statusCode).toBe(503);
        expect((await instance.inject({ method: 'POST', url: '/api/learning/1/open' })).statusCode).toBe(503);
        expect((await instance.inject({ method: 'POST', url: '/api/learning/1/test' })).statusCode).toBe(503);
        expect((await instance.inject({ method: 'POST', url: '/api/learning/run/1/finish' })).statusCode)
          .toBe(503);
      }
    } finally {
      await detached.close();
      await unavailable.close();
    }
  });
});
