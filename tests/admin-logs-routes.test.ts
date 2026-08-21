import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createParent,
  issueParentInvite,
  openControlDatabase,
  redeemParentInvite,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import { createAdminAccount, signInAdmin } from './server-harness.js';
import { LOGS_DIR, logFilePath, type LogEntry } from '../server/log.js';
import {
  registerAdminLogsRoutes,
  registerUnavailableAdminLogs,
} from '../server/routes/admin/logs.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const PARENT_PASSWORD = 'пароль-родителя';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  json: () => unknown;
}

interface Page {
  entries: LogEntry[];
  nextBefore?: string;
}

describe('маршрут журнала аварий', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let parentCookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-logs-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));

    const admin = signInAdmin(control, createAdminAccount(control, { now: NOW }), NOW);
    adminCookie = `${ADMIN_COOKIE}=${admin.token}`;

    const parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('родитель не вошёл');
    parentCookie = `${PARENT_COOKIE}=${redeemed.session.token}`;

    mkdirSync(resolve(dir, LOGS_DIR), { recursive: true });
    let text = '';
    for (let index = 0; index < 5; index += 1) {
      text += `${JSON.stringify({
        at: `2026-08-21T09:00:0${index}.000Z`,
        event: index % 2 === 0 ? 'server-error' : 'tenant-open-failed',
        message: `запись ${index}`,
        ...(index === 3 ? { childId: 'abcdef01' } : {}),
      })}\n`;
    }
    writeFileSync(logFilePath(dir), text);

    app = Fastify();
    registerAdminLogsRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      dataDir: dir,
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

  it('отдаёт ленту оператору, новые сверху', async () => {
    const response = await get('/api/admin/logs', { cookie: adminCookie });
    expect(response.statusCode).toBe(200);
    const page = response.json() as Page;
    expect(page.entries.map((entry) => entry.message)).toEqual([
      'запись 4',
      'запись 3',
      'запись 2',
      'запись 1',
      'запись 0',
    ]);
    expect(page.nextBefore).toBeUndefined();
  });

  it('фильтрует по событию и по ребёнку', async () => {
    const byEvent = await get('/api/admin/logs?event=tenant-open-failed', { cookie: adminCookie });
    expect((byEvent.json() as Page).entries.map((entry) => entry.message)).toEqual([
      'запись 3',
      'запись 1',
    ]);
    const byChild = await get('/api/admin/logs?child=abcdef01', { cookie: adminCookie });
    expect((byChild.json() as Page).entries.map((entry) => entry.message)).toEqual(['запись 3']);
  });

  it('пустой фильтр не сужает ленту', async () => {
    const response = await get('/api/admin/logs?child=&before=', { cookie: adminCookie });
    expect((response.json() as Page).entries).toHaveLength(5);
  });

  it('ведёт по курсору `before`', async () => {
    const response = await get('/api/admin/logs?before=2026-08-21T09:00:02.000Z', {
      cookie: adminCookie,
    });
    expect((response.json() as Page).entries.map((entry) => entry.message)).toEqual([
      'запись 2',
      'запись 1',
      'запись 0',
    ]);
  });

  it('неизвестное событие — 400, а не пустая лента', async () => {
    const response = await get('/api/admin/logs?event=всё-пропало', { cookie: adminCookie });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Неизвестное событие' });
  });

  it('отказывает родителю и анониму', async () => {
    const parent = await get('/api/admin/logs', { cookie: parentCookie });
    expect(parent.statusCode).toBe(401);
    const anonymous = await get('/api/admin/logs');
    expect(anonymous.statusCode).toBe(401);
  });

  it('отказывает по погашенной сессии оператора', async () => {
    control.prepare('UPDATE admin_sessions SET revoked_at = ?').run(NOW.toISOString());
    const response = await get('/api/admin/logs', { cookie: adminCookie });
    expect(response.statusCode).toBe(401);
  });

  it('на пустом журнале отдаёт пустую ленту, а не ошибку', async () => {
    rmSync(logFilePath(dir));
    const response = await get('/api/admin/logs', { cookie: adminCookie });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entries: [] });
  });

  it('заглушка отвечает 503, а не 404', async () => {
    const own = Fastify();
    registerUnavailableAdminLogs(own, 'управляющая база недоступна');
    await own.ready();
    const response = await own.inject({ method: 'GET', url: '/api/admin/logs' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Журнал недоступен: управляющая база недоступна' });
    await own.close();
  });
});
