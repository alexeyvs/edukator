import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  redeemDeviceInvite,
  redeemParentInvite,
  openControlDatabase,
  setParentPin,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { TenantRegistry } from '../server/tenant-registry.js';
import { hashParentPin } from '../server/parent-pin.js';
import { registerBossRoutes } from '../server/routes/boss.js';
import { registerGateRoutes } from '../server/routes/gate.js';
import { registerLearningRoutes } from '../server/routes/learning.js';
import { registerParentsRoutes } from '../server/routes/parents.js';
import { registerProfileRoutes } from '../server/routes/profile.js';
import { registerRunRoutes } from '../server/routes/run.js';
import { registerSessionRoutes } from '../server/routes/session.js';
import { registerTriageRoutes } from '../server/routes/triage.js';
import { createTenantContext, failAuth } from '../server/routes/tenant-context.js';

const NOW = new Date('2026-08-19T09:00:00.000Z');
const PASSWORD = 'пароль-подлиннее';
const PIN = '135790';
const PEPPER = 'серверный-pepper-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function topic(id: string): Topic {
  return {
    id,
    subject: 'math',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([topic('math.a')]);

interface Injected {
  statusCode: number;
  json: () => unknown;
}

/** Вид предъявителя вместе с заголовками, которыми он представляется. */
type BearerName = 'parent' | 'browser' | 'agent' | 'anonymous';

describe('контекст арендатора', () => {
  let dir: string;
  let seedDir: string;
  let control: Database;
  let tenants: TenantRegistry;
  let app: FastifyInstance;
  let childId: string;
  let otherChildId: string;
  let headers: Record<BearerName, Record<string, string>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-tenant-context-'));
    ensureDataDir(dir);
    seedDir = join(dir, 'посев');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'math.json'), JSON.stringify({ subject: 'math', topics: [] }));
    control = openControlDatabase(controlDatabasePath(dir));
    tenants = new TenantRegistry({
      control,
      dataDir: dir,
      graph: GRAPH,
      seedDir,
      log: () => undefined,
    });

    const parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('приглашение родителя не погашено');

    childId = createChild(control, parentId, 'Ученик', NOW);
    provisionChildDatabase(control, childId, dir);
    otherChildId = createChild(control, parentId, 'Второй', NOW);
    provisionChildDatabase(control, otherChildId, dir);

    headers = {
      parent: { ...SAME_ORIGIN, cookie: `${PARENT_COOKIE}=${redeemed.session.token}` },
      browser: { ...SAME_ORIGIN, cookie: `${CHILD_COOKIE}=${claim('browser')}` },
      agent: { ...SAME_ORIGIN, authorization: `Bearer ${claim('agent')}` },
      anonymous: { ...SAME_ORIGIN },
    };

    // PIN живёт в `control.db` и свой у каждой семьи: маршрут читает его
    // оттуда, а не из настроек процесса.
    setParentPin(control, parentId, hashParentPin(PIN, PEPPER));

    const context = createTenantContext({ control, tenants, now: () => NOW });
    app = Fastify();
    registerSessionRoutes(app, { context, graph: GRAPH, now: () => NOW, log: () => undefined });
    registerRunRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerTriageRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerBossRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerLearningRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerProfileRoutes(app, { context });
    registerGateRoutes(app, { context, now: () => NOW });
    registerParentsRoutes(app, {
      context,
      graph: GRAPH,
      control,
      pinPepper: PEPPER,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await tenants.closeAll();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Погашенное устройство ребёнка: наружу нужен только его постоянный токен. */
  function claim(kind: 'browser' | 'agent'): string {
    const invite = issueDeviceInvite(control, childId, kind, '', NOW);
    const claimed = redeemDeviceInvite(control, invite.token, NOW);
    if (!claimed.ok) throw new Error(`устройство ${kind} не погашено`);
    return claimed.token;
  }

  function get(url: string, bearer: BearerName): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers: headers[bearer] });
  }

  function put(
    url: string,
    bearer: BearerName,
    payload: Record<string, unknown>,
  ): Promise<Injected> {
    return app.inject({ method: 'PUT', url, headers: headers[bearer], payload });
  }

  describe('матрица допуска', () => {
    // Ожидание выписано руками, а не выведено из `ROUTE_ACCESS`: тест, который
    // строит его из той же таблицы, переживёт любую её подмену.
    const MATRIX = [
      { group: 'child', url: '/api/profile', parent: false, browser: true, agent: false },
      { group: 'gate', url: '/api/gate/status', parent: false, browser: true, agent: true },
      { group: 'dashboard', url: null, parent: true, browser: true, agent: false },
    ] as const;

    for (const row of MATRIX) {
      for (const bearer of ['parent', 'browser', 'agent'] as const) {
        const allowed = row[bearer];
        it(`${row.group}: предъявителя ${bearer} ${allowed ? 'пускает' : 'не пускает'}`, async () => {
          const response = await get(row.url ?? `/api/parents/${childId}`, bearer);
          if (allowed) expect(response.statusCode).toBe(200);
          else expect(response.statusCode).not.toBe(200);
        });
      }
    }

    it('не пускает никуда без предъявителя', async () => {
      for (const url of ['/api/profile', '/api/gate/status', `/api/parents/${childId}`]) {
        expect((await get(url, 'anonymous')).statusCode).toBe(401);
      }
    });

    it('отвечает агенту 403, а не молчаливым 404, на детских маршрутах', async () => {
      const response = await get('/api/profile', 'agent');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Доступ закрыт' });
    });

    it('отвечает родителю на детском маршруте 403: ребёнка он там не называл', async () => {
      const response = await get('/api/run/plan', 'parent');
      expect(response.statusCode).toBe(403);
    });

    it('не пускает ребёнка в сводку соседа: она неотличима от несуществующей', async () => {
      const response = await get(`/api/parents/${otherChildId}`, 'browser');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Ребёнок не найден' });
    });

    it('пускает родителя в сводку каждого своего ребёнка', async () => {
      expect((await get(`/api/parents/${childId}`, 'parent')).statusCode).toBe(200);
      expect((await get(`/api/parents/${otherChildId}`, 'parent')).statusCode).toBe(200);
    });
  });

  describe('PIN на изменяющих родительских маршрутах', () => {
    const url = (id: string): string => `/api/parents/${id}/computer-access`;

    it('даёт ребёнку читать свою сводку без PIN', async () => {
      const response = await get(`/api/parents/${childId}`, 'browser');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ computerAccess: { configured: true } });
    });

    it('не даёт ребёнку без PIN менять доступ к компьютеру', async () => {
      const response = await put(url(childId), 'browser', { mode: 'unlocked' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный PIN родителя' });
    });

    it('пускает ребёнка с верным PIN', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: url(childId),
        headers: { ...headers.browser, authorization: `Bearer ${PIN}` },
        payload: { mode: 'unlocked' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unlocked: true });
    });

    it('не спрашивает PIN у родительской сессии', async () => {
      const response = await put(url(childId), 'parent', { mode: 'blocked' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unlocked: false });
    });

    it('не даёт агенту менять доступ к компьютеру даже с верным PIN', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: url(childId),
        headers: { ...headers.agent, authorization: `Bearer ${PIN}` },
        payload: { mode: 'unlocked' },
      });
      // Токен агента ушёл из заголовка вместе с PIN: предъявителя нет вовсе.
      expect(response.statusCode).toBe(401);
    });
  });

  describe('база выбирается по предъявителю', () => {
    it('пишет профиль в базу своего ребёнка, а не соседа', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: headers.browser,
        payload: { name: 'Тимофей' },
      });
      expect(response.statusCode).toBe(200);

      expect(tenants.peek(childId)?.db.prepare<[], { name: string }>(
        'SELECT name FROM profile',
      ).get()?.name).toBe('Тимофей');
      // База соседа даже не открывалась: чужой ребёнок отсекается до реестра.
      expect(tenants.peek(otherChildId)).toBeUndefined();
    });

    it('не открывает базу, когда изменяющий запрос пришёл не со своей страницы', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: { cookie: headers.browser['cookie'] ?? '', origin: 'https://чужой.example' },
        payload: { name: 'Тимофей' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения' });
      expect(tenants.peek(childId)).toBeUndefined();
    });
  });

  describe('перевод отказа в ответ', () => {
    it('не глотает чужую ошибку: она обязана остаться пятисоткой', () => {
      const broken = new Error('это поломка кода');
      expect(() => failAuth({} as never, broken)).toThrow(broken);
    });
  });

  it('берёт время сам, когда его не подменили', async () => {
    const context = createTenantContext({ control, tenants });
    const own = Fastify();
    registerGateRoutes(own, { context });
    await own.ready();
    try {
      expect((await own.inject({
        method: 'GET',
        url: '/api/gate/status',
        headers: headers.browser,
      })).statusCode).toBe(200);
    } finally {
      await own.close();
    }
  });
});
