import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  childDatabasePath,
  createChild,
  createParent,
  issueParentInvite,
  markChildReady,
  openControlDatabase,
  redeemParentInvite,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { openDatabase } from '../server/db.js';
import { AdminStatsCache } from '../server/admin/stats.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import { createAdminAccount, signInAdmin } from './server-harness.js';
import {
  registerAdminStatsRoutes,
  registerUnavailableAdminStats,
} from '../server/routes/admin/stats.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
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

interface StatsBody {
  generatedAt: string;
  partial: boolean;
  children: Array<{ childId: string }>;
  failed: Array<{ childId: string; reason: string }>;
  stale: Array<{ childId: string }>;
}

describe('маршрут статистики оператора', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let parentCookie: string;
  let parentId: string;
  let clock: Date;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-stats-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    clock = NOW;

    const admin = signInAdmin(control, createAdminAccount(control, { now: NOW }), NOW);
    adminCookie = `${ADMIN_COOKIE}=${admin.token}`;

    parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('родитель не вошёл');
    parentCookie = `${PARENT_COOKIE}=${redeemed.session.token}`;

    app = Fastify();
    registerAdminStatsRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      cache: new AdminStatsCache({ control, dataDir: dir, graph: GRAPH, now: () => clock }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Ребёнок с настоящей базой нынешней схемы. */
  function child(name: string): string {
    const id = createChild(control, parentId, name, NOW);
    const db = openDatabase(childDatabasePath(dir, id));
    try {
      syncTopicState(db, GRAPH);
    } finally {
      db.close();
    }
    markChildReady(control, id);
    return id;
  }

  function get(url: string, headers: Record<string, string> = {}): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers: { ...SAME_ORIGIN, ...headers } });
  }

  it('отдаёт отчёт оператору с отметкой времени', async () => {
    child('Ученик');
    const response = await get('/api/admin/stats', { cookie: adminCookie });

    expect(response.statusCode).toBe(200);
    const body = response.json() as StatsBody;
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.children).toHaveLength(1);
    expect(body.partial).toBe(false);
  });

  it('отказывает родителю и анониму', async () => {
    const parent = await get('/api/admin/stats', { cookie: parentCookie });
    expect(parent.statusCode).toBe(401);
    const anonymous = await get('/api/admin/stats');
    expect(anonymous.statusCode).toBe(401);
  });

  it('держит отчёт до срока и пересчитывает по `refresh`', async () => {
    child('Первый');
    const first = await get('/api/admin/stats', { cookie: adminCookie });
    expect((first.json() as StatsBody).children).toHaveLength(1);

    child('Второй');
    clock = new Date(NOW.getTime() + 60_000);
    const cached = await get('/api/admin/stats', { cookie: adminCookie });
    const cachedBody = cached.json() as StatsBody;
    // Второй ребёнок в сохранённом отчёте не появился, и отметка времени осталась
    // прежней: подменённая на нынешнюю, она выдавала бы старые числа за свежие.
    expect(cachedBody.children).toHaveLength(1);
    expect(cachedBody.generatedAt).toBe(NOW.toISOString());

    const fresh = await get('/api/admin/stats?refresh=1', { cookie: adminCookie });
    const freshBody = fresh.json() as StatsBody;
    expect(freshBody.children).toHaveLength(2);
    expect(freshBody.generatedAt).toBe(clock.toISOString());
  });

  it('требует свой источник только для принудительного пересчёта', async () => {
    child('Ученик');

    const cached = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: adminCookie },
    });
    expect(cached.statusCode).toBe(200);

    const forced = await app.inject({
      method: 'GET',
      url: '/api/admin/stats?refresh=1',
      headers: { cookie: adminCookie },
    });
    expect(forced.statusCode).toBe(403);
    expect(forced.json()).toEqual({
      error: 'Запрос пришёл не со страницы приложения',
      code: 'cross-origin',
    });

    const sameOrigin = await get('/api/admin/stats?refresh=1', { cookie: adminCookie });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it('отдаёт неполный отчёт признаком неполноты, а не пятисоткой', async () => {
    const целый = child('Целый');
    const битый = child('Битый');
    writeFileSync(childDatabasePath(dir, битый), 'это не sqlite');

    const response = await get('/api/admin/stats', { cookie: adminCookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatsBody;
    expect(body.partial).toBe(true);
    expect(body.failed.map((row) => row.childId)).toEqual([битый]);
    // Числа по остальным детям посчитаны: отказ одной базы не отменяет отчёта.
    expect(body.children.map((row) => row.childId)).toEqual([целый]);
  });

  it('заглушка отвечает 503, а не 404', async () => {
    const own = Fastify();
    registerUnavailableAdminStats(own, 'управляющая база недоступна');
    await own.ready();
    const response = await own.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Статистика недоступна: управляющая база недоступна' });
    await own.close();
  });
});
