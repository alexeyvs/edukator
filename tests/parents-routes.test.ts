import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { hashParentPin } from '../server/parent-pin.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { openControlDatabase, setParentPin } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { registerParentsRoutes, registerUnavailableParents } from '../server/routes/parents.js';
import { fakeContext, FAKE_CHILD_ID } from './tenant-context-helper.js';
import { startTenantServer, type TenantServer } from './server-harness.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const PARENT_PIN = '123456';
const PIN_PEPPER = 'pepper-для-тестов-достаточной-длины';
/** Пятнадцать минут паузы `LOGIN_LOCKOUT_MS` в секундах ответа. */
const LOCKOUT_SECONDS = '900';

describe('маршрут родителей', () => {
  let dir: string;
  let curriculumDir: string;
  let seedDir: string;
  let clock: Date;
  let server: TenantServer;
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
    clock = NOW;
    server = await startTenantServer({
      dataDir: join(dir, 'data'),
      curriculumDir,
      seedDir,
      now: () => clock,
      worker: false,
      pinPepper: PIN_PEPPER,
    });
    app = server.app;
    db = openDatabase(server.dbPath);
    // PIN живёт в `control.db` и ставится родительским маршрутом семьи; здесь
    // он кладётся напрямую — предмет теста не в том, как его завели.
    setParentPin(server.control, server.parentId, hashParentPin(PARENT_PIN, PIN_PEPPER));
  });

  it('по запросу раскрывает вопросы, ответы, эталон и время завершённого занятия', async () => {
    const runId = Number(db.prepare(
      `INSERT INTO runs
        (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
       VALUES ('math', 'run', 'math.internal-secret', ?, ?, '{}', 1, 0)`,
    ).run('2026-08-08T10:00:00.000Z', '2026-08-08T10:10:00.000Z').lastInsertRowid);
    const taskId = Number(db.prepare(
      `INSERT INTO task_bank
        (topic_id, question, answer, hint, explain, difficulty, status)
       VALUES ('math.internal-secret', 'Сколько будет 2 + 2?', '4', 'Сложи числа',
               'Два плюс два равно четырём.', 1, 'used')`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, created_at)
       VALUES (?, 'math.internal-secret', ?, '5', 0, 1, 12500, ?)`,
    ).run(taskId, runId, '2026-08-08T10:05:00.000Z');

    const response = await app.inject({
      method: 'GET',
      url: `/api/parents/${server.childId}/runs/${String(runId)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId,
      kind: 'run',
      subject: 'math',
      activeMilliseconds: 12_500,
      attempts: [{
        number: 1,
        topicTitle: 'Публичная тема math',
        question: 'Сколько будет 2 + 2?',
        studentAnswer: '5',
        correctAnswer: '4',
        explanation: 'Два плюс два равно четырём.',
        hint: 'Сложи числа',
        correct: false,
        durationMilliseconds: 12_500,
      }],
    });
    expect(response.body).not.toContain('internal-secret');
  });

  it('проверяет id и не раскрывает занятие вне недельной сводки', async () => {
    expect((await app.inject({
      method: 'GET',
      url: `/api/parents/${server.childId}/runs/nope`,
    })).statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/parents/${server.childId}/runs/999`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Занятие не найдено в текущей недельной сводке' });
  });

  afterEach(async () => {
    db.close();
    await server.close();
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

    const response = await app.inject({ method: 'GET', url: `/api/parents/${server.childId}` });
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
      url: `/api/parents/${server.childId}/computer-access`,
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
    expect((await app.inject({ method: 'GET', url: `/api/parents/${server.childId}` })).json())
      .toMatchObject({ computerAccess: { override: { mode: 'unlocked' }, unlocked: true } });

    const automatic = await change('automatic');
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json()).toMatchObject({
      automaticUnlocked: false,
      override: null,
      unlocked: false,
    });
  });

  // PIN свой у каждой семьи: общий на процесс означал бы, что сосед по серверу
  // управляет доступом к компьютеру чужого ребёнка своими цифрами.
  it('не принимает PIN одной семьи на ребёнке другой', async () => {
    const other = server.addFamily('сосед@example.com');

    const foreign = await app.inject({
      method: 'PUT',
      url: `/api/parents/${other.child.childId}/computer-access`,
      headers: { ...other.child.headers, authorization: `Bearer ${PARENT_PIN}` },
      payload: { mode: 'blocked' },
    });

    // У соседа PIN не настроен вовсе, и чужой сюда не подходит ни при каких
    // цифрах: 503 «не настроен», а не 200 и не «неверный PIN».
    expect(foreign.statusCode).toBe(503);
    expect(foreign.json()).toEqual({
      error: 'Управление доступом недоступно: PIN родителя не настроен',
    });
    expect((await app.inject({
      method: 'GET',
      url: `/api/parents/${other.child.childId}`,
      headers: other.child.headers,
    })).json()).toMatchObject({ computerAccess: { configured: false } });
  });

  it('без серверного pepper считает PIN ненастроенным, а не принимает его', async () => {
    const withoutPepper = await startTenantServer({
      dataDir: join(dir, 'без-pepper'),
      curriculumDir,
      seedDir,
      now: () => clock,
      worker: false,
      // Явно пустой pepper: короткий и отсутствующий — одно и то же состояние.
      pinPepper: 'короткий',
    });
    try {
      setParentPin(
        withoutPepper.control,
        withoutPepper.parentId,
        hashParentPin(PARENT_PIN, PIN_PEPPER),
      );
      const status = await withoutPepper.app.inject({
        method: 'GET',
        url: `/api/parents/${withoutPepper.childId}`,
      });
      expect(status.json()).toMatchObject({ computerAccess: { configured: false } });

      const response = await withoutPepper.app.inject({
        method: 'PUT',
        url: `/api/parents/${withoutPepper.childId}/computer-access`,
        headers: { authorization: `Bearer ${PARENT_PIN}` },
        payload: { mode: 'automatic' },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await withoutPepper.close();
    }
  });

  it('возвращает 400 для некорректного режима и 401 для неверного Bearer PIN', async () => {
    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/parents/${server.childId}/computer-access`,
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
        url: `/api/parents/${server.childId}/computer-access`,
        ...(authorization === undefined ? {} : { headers: { authorization } }),
        payload: { mode: 'blocked' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный PIN родителя' });
    }
  });

  describe('счётчик неудачных PIN', () => {
    function attempt(pin: string, remoteAddress = '192.0.2.1', childId = server.childId) {
      return app.inject({
        method: 'PUT',
        url: `/api/parents/${childId}/computer-access`,
        remoteAddress,
        headers: { authorization: `Bearer ${pin}` },
        payload: { mode: 'blocked' },
      });
    }

    // Счётчик живёт в `control.db`, а не в памяти процесса: иначе перезапуск
    // сервера — то, что подбирающий вызвать умеет, — снимал бы паузу.
    it('после пяти ошибок закрывает семью и с другого адреса', async () => {
      for (let index = 0; index < 5; index += 1) {
        expect((await attempt('000000')).statusCode).toBe(401);
      }

      const blocked = await attempt(PARENT_PIN);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe(LOCKOUT_SECONDS);
      // Смена адреса паузу не снимает: считается ещё и учётная запись родителя.
      expect((await attempt(PARENT_PIN, '198.51.100.7')).statusCode).toBe(429);

      clock = new Date(NOW.getTime() + 15 * 60 * 1000 + 1);
      expect((await attempt(PARENT_PIN)).statusCode).toBe(200);
    });

    // Порог по адресу выше почтового намеренно: за одним адресом стоит вся
    // семья вместе с NAT, и общий порог означал бы, что ошибившийся брат
    // закрывает вход соседней семье.
    it('не закрывает соседнюю семью, ошибавшуюся с того же адреса', async () => {
      const other = server.addFamily('сосед@example.com');
      setParentPin(server.control, other.parentId, hashParentPin('654321', PIN_PEPPER));
      for (let index = 0; index < 5; index += 1) {
        expect((await attempt('000000')).statusCode).toBe(401);
      }

      const neighbour = await app.inject({
        method: 'PUT',
        url: `/api/parents/${other.child.childId}/computer-access`,
        remoteAddress: '192.0.2.1',
        headers: { ...other.child.headers, authorization: 'Bearer 654321' },
        payload: { mode: 'blocked' },
      });

      expect((await attempt(PARENT_PIN)).statusCode).toBe(429);
      expect(neighbour.statusCode).toBe(200);
    });

    it('верный PIN до предела гасит почтовый счётчик', async () => {
      for (let index = 0; index < 4; index += 1) {
        expect((await attempt('000000')).statusCode).toBe(401);
      }
      expect((await attempt(PARENT_PIN)).statusCode).toBe(200);

      for (let index = 0; index < 5; index += 1) {
        expect((await attempt('000000')).statusCode).toBe(401);
      }
      expect((await attempt(PARENT_PIN)).statusCode).toBe(429);
    });
  });

  it('возвращает 503, когда PIN не настроен', async () => {
    const withoutPin = Fastify();
    const control = openControlDatabase(controlDatabasePath(ensureDataDir(join(dir, 'без-pin'))));
    registerParentsRoutes(withoutPin, {
      context: fakeContext(db),
      graph: loadCurriculum(curriculumDir),
      control,
      pinPepper: PIN_PEPPER,
      now: () => NOW,
    });
    await withoutPin.ready();
    try {
      const dashboard = await withoutPin.inject({ method: 'GET', url: `/api/parents/${FAKE_CHILD_ID}` });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({ computerAccess: { configured: false } });
      const response = await withoutPin.inject({
        method: 'PUT',
        url: `/api/parents/${FAKE_CHILD_ID}/computer-access`,
        payload: { mode: 'blocked' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'Управление доступом недоступно: PIN родителя не настроен',
      });
    } finally {
      await withoutPin.close();
      control.close();
    }
  });

  it('отдаёт явный 503 при отвязанной и не поднятой базе', async () => {
    const detached = Fastify();
    const control = openControlDatabase(controlDatabasePath(ensureDataDir(join(dir, 'отвязанная'))));
    registerParentsRoutes(detached, {
      context: fakeContext(db, { available: () => false }),
      graph: loadCurriculum(curriculumDir),
      control,
    });
    const unavailable = Fastify();
    registerUnavailableParents(unavailable, 'карта тем не загружена');
    await Promise.all([detached.ready(), unavailable.ready()]);
    try {
      expect((await detached.inject({ method: 'GET', url: `/api/parents/${FAKE_CHILD_ID}` })).statusCode).toBe(503);
      expect((await unavailable.inject({ method: 'GET', url: `/api/parents/${FAKE_CHILD_ID}` })).statusCode).toBe(503);
      expect((await detached.inject({ method: 'GET', url: `/api/parents/${FAKE_CHILD_ID}/runs/1` })).statusCode).toBe(503);
      expect((await unavailable.inject({ method: 'GET', url: `/api/parents/${FAKE_CHILD_ID}/runs/1` })).statusCode).toBe(503);
      expect((await detached.inject({
        method: 'PUT', url: `/api/parents/${FAKE_CHILD_ID}/computer-access`, payload: { mode: 'blocked' },
      })).statusCode).toBe(503);
      expect((await unavailable.inject({
        method: 'PUT', url: `/api/parents/${FAKE_CHILD_ID}/computer-access`, payload: { mode: 'blocked' },
      })).statusCode).toBe(503);
    } finally {
      await Promise.all([detached.close(), unavailable.close()]);
      control.close();
    }
  });
});
