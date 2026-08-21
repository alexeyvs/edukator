import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  childDatabasePath,
  createAdmin,
  createChild,
  createParent,
  issueParentInvite,
  loginAdmin,
  markChildReady,
  openControlDatabase,
  redeemParentInvite,
  setAdminPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { openDatabase } from '../server/db.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import {
  registerAdminChildrenRoutes,
  registerUnavailableAdminChildren,
} from '../server/routes/admin/children.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
/** Нижняя граница пароля оператора — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
const PARENT_PASSWORD = 'пароль-родителя';
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

describe('маршрут карточки ребёнка', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let parentCookie: string;
  let parentId: string;
  let childId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-children-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));

    const adminId = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, NOW);
    const entered = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD, NOW);
    if (!entered.ok) throw new Error('оператор не вошёл');
    adminCookie = `${ADMIN_COOKIE}=${entered.session.token}`;

    parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('родитель не вошёл');
    parentCookie = `${PARENT_COOKIE}=${redeemed.session.token}`;

    childId = createChild(control, parentId, 'Ученик', NOW);
    const db = openDatabase(childDatabasePath(dir, childId));
    try {
      syncTopicState(db, GRAPH);
    } finally {
      db.close();
    }
    markChildReady(control, childId);

    app = Fastify();
    registerAdminChildrenRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
      dataDir: dir,
      graph: GRAPH,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function get(url: string, headers: Record<string, string> = {}): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers: { ...SAME_ORIGIN, ...headers } });
  }

  it('отдаёт карточку названного ребёнка', async () => {
    const response = await get(`/api/admin/children/${childId}`, { cookie: adminCookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: 'read',
      childId,
      name: 'Ученик',
      parentId,
      generatedAt: NOW.toISOString(),
    });
  });

  it('отвечает `no-child` на чужой формат идентификатора', async () => {
    const response = await get('/api/admin/children/..%2Fcontrol', { cookie: adminCookie });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'no-child' });
  });

  it('отвечает `no-child` на незаведённого ребёнка тем же самым', async () => {
    const response = await get('/api/admin/children/0123456789abcdef', { cookie: adminCookie });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'no-child' });
  });

  it('отдаёт причину отказа базы, а не пятисотку', async () => {
    // Заведение застряло: строка в `control.db` есть, файла базы ещё нет.
    const застрявший = createChild(control, parentId, 'Застрявший', NOW);
    const response = await get(`/api/admin/children/${застрявший}`, { cookie: adminCookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'failed', status: 'provisioning' });
  });

  it('отказывает родителю и анониму', async () => {
    const parent = await get(`/api/admin/children/${childId}`, { cookie: parentCookie });
    expect(parent.statusCode).toBe(401);
    const anonymous = await get(`/api/admin/children/${childId}`);
    expect(anonymous.statusCode).toBe(401);
  });

  it('заглушка отвечает 503, а не 404', async () => {
    const own = Fastify();
    registerUnavailableAdminChildren(own, 'управляющая база недоступна');
    await own.ready();
    const response = await own.inject({ method: 'GET', url: '/api/admin/children/0123456789abcdef' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Карточка ребёнка недоступна: управляющая база недоступна',
    });
    await own.close();
  });
});
