import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ADMIN_AUDIT_PAGE,
  createAdmin,
  loginAdmin,
  openControlDatabase,
  recordAdminAudit,
  setAdminPassword,
  type AdminAuditAction,
  type AdminAuditCursor,
  type AdminAuditEntry,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import {
  registerAdminAuditRoutes,
  registerUnavailableAdminAudit,
} from '../server/routes/admin/audit.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
/** Нижняя граница пароля оператора — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  json: () => unknown;
}

describe('маршрут журнала действий оператора', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminId: string;
  let adminCookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-audit-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));

    adminId = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, NOW);
    const login = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD, NOW);
    if (!login.ok) throw new Error('оператор не вошёл');
    adminCookie = `${ADMIN_COOKIE}=${login.session.token}`;

    app = Fastify();
    registerAdminAuditRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Запись журнала с отметкой на `minute` минут позже начала. */
  function write(action: AdminAuditAction, minute: number): void {
    recordAdminAudit(control, { adminId, action }, new Date(NOW.getTime() + minute * 60 * 1000));
  }

  function get(url: string, cookie: string = adminCookie): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers: { ...SAME_ORIGIN, cookie } });
  }

  it('отдаёт ленту новыми сверху', async () => {
    write('login', 0);
    write('impersonation-start', 1);
    write('impersonation-end', 2);

    const response = await get('/api/admin/audit');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: AdminAuditEntry[]; next?: AdminAuditCursor };
    expect(body.entries.map((entry) => entry.action)).toEqual([
      'impersonation-end',
      'impersonation-start',
      'login',
    ]);
    expect(body.next).toBeUndefined();
  });

  it('фильтрует по действию', async () => {
    write('login', 0);
    write('login-failed', 1);
    write('login', 2);

    const body = (await get('/api/admin/audit?action=login-failed')).json() as {
      entries: AdminAuditEntry[];
    };
    expect(body.entries.map((entry) => entry.action)).toEqual(['login-failed']);
  });

  it('отвечает 400 на неизвестное действие, а не пустой лентой', async () => {
    write('login', 0);
    const response = await get('/api/admin/audit?action=импресонация');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Неизвестное действие' });
  });

  it('продолжает страницу курсором', async () => {
    for (let minute = 0; minute < ADMIN_AUDIT_PAGE + 2; minute += 1) write('login', minute);

    const first = (await get('/api/admin/audit')).json() as {
      entries: AdminAuditEntry[];
      next?: AdminAuditCursor;
    };
    expect(first.entries).toHaveLength(ADMIN_AUDIT_PAGE);
    expect(first.next).toBeDefined();

    const cursor = first.next as AdminAuditCursor;
    const second = (
      await get(`/api/admin/audit?before=${encodeURIComponent(cursor.at)}&beforeId=${cursor.id}`)
    ).json() as { entries: AdminAuditEntry[]; next?: AdminAuditCursor };
    expect(second.entries).toHaveLength(2);
    expect(second.next).toBeUndefined();
    // Записи не повторяются: обе половины курсора доехали.
    const ids = new Set(first.entries.map((entry) => entry.id));
    expect(second.entries.some((entry) => ids.has(entry.id))).toBe(false);
  });

  it('отвергает половину курсора', async () => {
    write('login', 0);
    for (const query of ['?before=2026-08-21T09:00:00.000Z', '?beforeId=3', '?before=x&beforeId=нет']) {
      const response = await get(`/api/admin/audit${query}`);
      expect([query, response.statusCode]).toEqual([query, 400]);
      expect(response.json()).toEqual({ error: 'Курсор задаётся парой before и beforeId' });
    }
  });

  it('не пускает никого, кроме оператора', async () => {
    write('login', 0);
    expect((await get('/api/admin/audit', '')).statusCode).toBe(401);
    expect((await get('/api/admin/audit', `${PARENT_COOKIE}=что-то`)).statusCode).toBe(401);
  });
});

describe('заглушка журнала действий', () => {
  it('отвечает 503 без управляющей базы', async () => {
    const app = Fastify();
    registerUnavailableAdminAudit(app, 'управляющая база недоступна');
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/admin/audit' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Журнал действий недоступен: управляющая база недоступна',
    });
    await app.close();
  });
});
