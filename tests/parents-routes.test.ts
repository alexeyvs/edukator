import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildServer } from '../server/index.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { registerParentsRoutes, registerUnavailableParents } from '../server/routes/parents.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

describe('маршрут родителей', () => {
  let dir: string;
  let curriculumDir: string;
  let seedDir: string;
  let app: FastifyInstance;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-parents-routes-'));
    curriculumDir = join(dir, 'curriculum');
    seedDir = join(dir, 'seed');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    for (const subject of SUBJECTS) {
      writeFileSync(join(curriculumDir, `${subject}.json`), JSON.stringify({
        subject,
        topics: [{ id: `${subject}.internal-secret`, subject, title: `Публичная тема ${subject}`,
          exam_weight: 3, difficulty: 2, prereqs: [], answer_format: 'text', prompt_seed: 'Проверяй знания по теме' }],
      }));
    }
    process.env.EDUKATOR_DB = join(dir, 'parents.db');
    app = buildServer(curriculumDir, { seedDir, now: () => NOW, worker: false });
    await app.ready();
    db = openDatabase(process.env.EDUKATOR_DB);
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  it('возвращает один снимок и не раскрывает внутренние id тем и ответы банка', async () => {
    db.prepare(
      `UPDATE topic_state SET mastery = .2, confidence = .8, attempts = 3,
       last_seen = ? WHERE topic_id = 'math.internal-secret'`,
    ).run(NOW.toISOString());
    const taskId = Number(db.prepare(
      `INSERT INTO task_bank (topic_id, question, answer, accept, hint, difficulty, status)
       VALUES ('math.internal-secret', 'Вопрос', 'СКРЫТЫЙ ОТВЕТ', '["СЕКРЕТНЫЙ ACCEPT"]',
               'СКРЫТАЯ ПОДСКАЗКА', 2, 'used')`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts (task_id, topic_id, answer, is_correct, duration_ms, created_at)
       VALUES (?, 'math.internal-secret', 'ответ ученика', 0, 60000, ?)`,
    ).run(taskId, NOW.toISOString());

    const response = await app.inject({ method: 'GET', url: '/api/parents' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      generatedAt: NOW.toISOString(),
      time: { plannedMinutes: 630, actualMinutes: 1 },
      gaps: [{ title: 'Публичная тема math', subject: 'math' }],
    });
    expect(response.body).not.toContain('internal-secret');
    expect(response.body).not.toContain('СКРЫТЫЙ ОТВЕТ');
    expect(response.body).not.toContain('СЕКРЕТНЫЙ ACCEPT');
    expect(response.body).not.toContain('СКРЫТАЯ ПОДСКАЗКА');
  });

  it('отдаёт явный 503 при отвязанной и не поднятой базе', async () => {
    const detached = Fastify();
    registerParentsRoutes(detached, {
      db, graph: loadCurriculum(curriculumDir), available: () => false,
    });
    const unavailable = Fastify();
    registerUnavailableParents(unavailable, 'карта тем не загружена');
    await Promise.all([detached.ready(), unavailable.ready()]);
    try {
      expect((await detached.inject({ method: 'GET', url: '/api/parents' })).statusCode).toBe(503);
      expect((await unavailable.inject({ method: 'GET', url: '/api/parents' })).statusCode).toBe(503);
    } finally {
      await Promise.all([detached.close(), unavailable.close()]);
    }
  });
});
