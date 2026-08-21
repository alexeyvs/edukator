import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createAdmin,
  createChild,
  createParent,
  issueParentInvite,
  loginAdmin,
  openControlDatabase,
  redeemParentInvite,
  setAdminPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import {
  registerAdminOverviewRoutes,
  registerUnavailableAdminOverview,
} from '../server/routes/admin/overview.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
/** Нижняя граница пароля оператора — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
const PARENT_PASSWORD = 'пароль-родителя';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  json: () => unknown;
}

describe('маршрут сводки оператора', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let parentCookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-overview-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));

    const adminId = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, NOW);
    const entered = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD, NOW);
    if (!entered.ok) throw new Error('оператор не вошёл');
    adminCookie = `${ADMIN_COOKIE}=${entered.session.token}`;

    const parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('родитель не вошёл');
    parentCookie = `${PARENT_COOKIE}=${redeemed.session.token}`;
    createChild(control, parentId, 'Ребёнок', NOW);

    app = Fastify();
    registerAdminOverviewRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
      dataDir: dir,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function get(headers: Record<string, string> = {}): Promise<Injected> {
    return app.inject({ method: 'GET', url: '/api/admin/overview', headers: { ...SAME_ORIGIN, ...headers } });
  }

  it('отдаёт сводку оператору', async () => {
    const response = await get({ cookie: adminCookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { generatedAt: string; children: { total: number } };
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.children.total).toBe(1);
  });

  it('отказывает родителю и анониму', async () => {
    const parent = await get({ cookie: parentCookie });
    expect(parent.statusCode).toBe(401);
    const anonymous = await get();
    expect(anonymous.statusCode).toBe(401);
  });

  it('отказывает по погашенной сессии оператора', async () => {
    control.prepare('UPDATE admin_sessions SET revoked_at = ?').run(NOW.toISOString());
    const response = await get({ cookie: adminCookie });
    expect(response.statusCode).toBe(401);
  });

  it('заглушка отвечает 503, а не 404', async () => {
    const own = Fastify();
    registerUnavailableAdminOverview(own, 'управляющая база недоступна');
    await own.ready();
    const response = await own.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Сводка недоступна: управляющая база недоступна' });
    await own.close();
  });
});
