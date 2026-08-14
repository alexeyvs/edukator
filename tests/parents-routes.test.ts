import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildServer } from '../server/index.js';
import { readParentPin, verifyParentPin } from '../server/parent-pin.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { registerParentsRoutes, registerUnavailableParents } from '../server/routes/parents.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const PARENT_PIN = '123456';

describe('PIN родителей', () => {
  it('принимает только от 6 до 12 цифр', () => {
    expect(readParentPin(undefined)).toBeUndefined();
    expect(readParentPin('12345')).toBeUndefined();
    expect(readParentPin('1234567890123')).toBeUndefined();
    expect(readParentPin('12345a')).toBeUndefined();
    expect(readParentPin(' 123456')).toBeUndefined();
    expect(readParentPin('123456')).toBe('123456');
    expect(readParentPin('123456789012')).toBe('123456789012');
  });

  it('сравнивает PIN через проверку дайджестов фиксированной длины', () => {
    expect(verifyParentPin(PARENT_PIN, PARENT_PIN)).toBe(true);
    expect(verifyParentPin(PARENT_PIN, '123457')).toBe(false);
    expect(verifyParentPin(PARENT_PIN, '1')).toBe(false);
  });
});

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
    process.env.EDUKATOR_PARENT_PIN = '999999';
    app = buildServer(curriculumDir, {
      seedDir,
      now: () => NOW,
      worker: false,
      parentPin: PARENT_PIN,
    });
    await app.ready();
    db = openDatabase(process.env.EDUKATOR_DB);
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    delete process.env.EDUKATOR_PARENT_PIN;
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
      computerAccess: {
        day: '2026-08-08',
        configured: true,
        automaticUnlocked: false,
        override: null,
        unlocked: false,
      },
      time: { plannedMinutes: 630, actualMinutes: 1 },
      gaps: [{ title: 'Публичная тема math', subject: 'math' }],
    });
    expect(response.body).not.toContain('internal-secret');
    expect(response.body).not.toContain('СКРЫТЫЙ ОТВЕТ');
    expect(response.body).not.toContain('СЕКРЕТНЫЙ ACCEPT');
    expect(response.body).not.toContain('СКРЫТАЯ ПОДСКАЗКА');
  });

  it('устанавливает оба ручных режима и возвращает управление автоматике', async () => {
    const change = async (mode: string) => app.inject({
      method: 'PUT',
      url: '/api/parents/computer-access',
      headers: { authorization: `Bearer ${PARENT_PIN}` },
      payload: { mode },
    });

    const blocked = await change('blocked');
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({
      automaticUnlocked: false,
      override: {
        mode: 'blocked',
        changedAt: NOW.toISOString(),
        expiresAt: '2026-08-08T21:00:00.000Z',
      },
      unlocked: false,
    });

    const unlocked = await change('unlocked');
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({
      automaticUnlocked: false,
      override: { mode: 'unlocked' },
      unlocked: true,
    });
    expect((await app.inject({ method: 'GET', url: '/api/parents' })).json())
      .toMatchObject({ computerAccess: { override: { mode: 'unlocked' }, unlocked: true } });

    const automatic = await change('automatic');
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json()).toMatchObject({
      automaticUnlocked: false,
      override: null,
      unlocked: false,
    });
  });

  it('читает PIN из EDUKATOR_PARENT_PIN без тестовой подмены', async () => {
    process.env.EDUKATOR_PARENT_PIN = '654321';
    const fromEnvironment = buildServer(curriculumDir, {
      seedDir,
      now: () => NOW,
      worker: false,
    });
    await fromEnvironment.ready();
    try {
      const response = await fromEnvironment.inject({
        method: 'PUT',
        url: '/api/parents/computer-access',
        headers: { authorization: 'Bearer 654321' },
        payload: { mode: 'automatic' },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await fromEnvironment.close();
      process.env.EDUKATOR_PARENT_PIN = '999999';
    }
  });

  it('возвращает 400 для некорректного режима и 401 для неверного Bearer PIN', async () => {
    const malformed = await app.inject({
      method: 'PUT',
      url: '/api/parents/computer-access',
      headers: { authorization: `Bearer ${PARENT_PIN}` },
      payload: { mode: 'forever' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: 'Поле mode должно быть одним из: automatic, blocked, unlocked',
    });

    for (const authorization of [undefined, 'Basic 123456', 'Bearer 999999']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/parents/computer-access',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
        payload: { mode: 'blocked' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный PIN родителя' });
    }
  });

  it('после пяти ошибок ограничивает только этот IP на пять минут', async () => {
    let clock = NOW.getTime();
    const limited = Fastify();
    registerParentsRoutes(limited, {
      db,
      graph: loadCurriculum(curriculumDir),
      parentPin: PARENT_PIN,
      now: () => new Date(clock),
    });
    await limited.ready();
    const request = (pin: string, remoteAddress: string) => limited.inject({
      method: 'PUT',
      url: '/api/parents/computer-access',
      remoteAddress,
      headers: { authorization: `Bearer ${pin}` },
      payload: { mode: 'blocked' },
    });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await request('000000', '192.0.2.1')).statusCode).toBe(401);
      }
      const blocked = await request(PARENT_PIN, '192.0.2.1');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('300');
      expect((await request(PARENT_PIN, '192.0.2.2')).statusCode).toBe(200);

      clock += 5 * 60 * 1000;
      expect((await request(PARENT_PIN, '192.0.2.1')).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('возвращает 503, когда PIN не настроен', async () => {
    const withoutPin = Fastify();
    registerParentsRoutes(withoutPin, {
      db,
      graph: loadCurriculum(curriculumDir),
      now: () => NOW,
    });
    await withoutPin.ready();
    try {
      const dashboard = await withoutPin.inject({ method: 'GET', url: '/api/parents' });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({ computerAccess: { configured: false } });
      const response = await withoutPin.inject({
        method: 'PUT',
        url: '/api/parents/computer-access',
        payload: { mode: 'blocked' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'Управление доступом недоступно: PIN родителя не настроен',
      });
    } finally {
      await withoutPin.close();
    }
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
      expect((await detached.inject({
        method: 'PUT', url: '/api/parents/computer-access', payload: { mode: 'blocked' },
      })).statusCode).toBe(503);
      expect((await unavailable.inject({
        method: 'PUT', url: '/api/parents/computer-access', payload: { mode: 'blocked' },
      })).statusCode).toBe(503);
    } finally {
      await Promise.all([detached.close(), unavailable.close()]);
    }
  });
});
