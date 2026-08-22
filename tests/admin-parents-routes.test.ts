import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  MIN_PASSWORD_LENGTH,
  PARENT_INVITE_TTL_MS,
  createChild,
  createParent,
  disableParent,
  findParentByEmail,
  issueDeviceInvite,
  issueParentInvite,
  listAdminAudit,
  loginParent,
  markChildReady,
  openControlDatabase,
  readParentInvite,
  redeemDeviceInvite,
  redeemParentInvite,
  resolveParentSession,
  listDevices,
} from '../server/control-db.js';
import { MAX_SECRET_LENGTH } from '../server/secrets.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { ADMIN_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { createAdminContext } from '../server/routes/tenant-context.js';
import { createAdminAccount, signInAdmin } from './server-harness.js';
import {
  registerAdminParentsRoutes,
  registerUnavailableAdminParents,
} from '../server/routes/admin/parents.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const PARENT_PASSWORD = 'пароль-родителя';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  json: () => unknown;
}

describe('маршруты семей в админке', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let adminId: string;
  let adminCookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-parents-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));

    const admin = signInAdmin(control, createAdminAccount(control, { now: NOW }), NOW);
    adminId = admin.adminId;
    adminCookie = `${ADMIN_COOKIE}=${admin.token}`;

    app = Fastify();
    registerAdminParentsRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function post(url: string, payload: object, cookie = adminCookie): Promise<Injected> {
    return app.inject({ method: 'POST', url, headers: { ...SAME_ORIGIN, cookie }, payload });
  }

  /** Родитель с паролем и живой сессией: с него начинаются оба сброса. */
  function parentWithPassword(email = 'родитель@example.com'): { parentId: string; token: string } {
    const parentId = createParent(control, email, NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error(`родитель ${email} не завёл пароль`);
    return { parentId, token: redeemed.session.token };
  }

  function actions(): string[] {
    return listAdminAudit(control, { limit: 20 }).entries.map((entry) => entry.action);
  }

  describe('заведение семьи', () => {
    it('заводит родителя и выпускает ему одноразовую ссылку', async () => {
      const response = await post('/api/admin/parents', { email: ' Родитель@Example.COM ' });

      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        parent: { parentId: string; email: string; hasPassword: boolean };
        invite: { path: string; expiresAt: string };
      };
      expect(body.parent.email).toBe('родитель@example.com');
      expect(body.parent.hasPassword).toBe(false);
      expect(body.invite.expiresAt).toBe(new Date(NOW.getTime() + PARENT_INVITE_TTL_MS).toISOString());

      // Ссылка отдана путём и работает: по ней родитель и заводит себе пароль.
      const token = body.invite.path.replace('/invite/', '');
      expect(readParentInvite(control, token, NOW)).toEqual({
        ok: true,
        parentId: body.parent.parentId,
        email: 'родитель@example.com',
      });
      expect(findParentByEmail(control, 'родитель@example.com')?.id).toBe(body.parent.parentId);
    });

    it('пишет заведение в журнал действий, не роняя туда токен', async () => {
      const response = await post('/api/admin/parents', { email: 'родитель@example.com' });
      const body = response.json() as { invite: { path: string } };

      const entries = listAdminAudit(control, { limit: 20 }).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('parent-create');
      expect(entries[0]?.adminId).toBe(adminId);
      expect(entries[0]?.detail).toContain('родитель@example.com');
      // Одноразовый токен в журнале — это второй экземпляр ссылки, живущий
      // дольше самой ссылки: прочитавший ленту получил бы вход в семью.
      expect(JSON.stringify(entries)).not.toContain(body.invite.path.replace('/invite/', ''));
    });

    it('отказывает по не-адресу и по уже заведённому адресу, ничего не записав', async () => {
      expect((await post('/api/admin/parents', { email: 'не адрес' })).statusCode).toBe(400);
      expect((await post('/api/admin/parents', {})).statusCode).toBe(400);
      expect((await post('/api/admin/parents', { email: 'a@b.c', лишнее: 1 })).statusCode).toBe(400);
      expect(actions()).toEqual([]);

      expect((await post('/api/admin/parents', { email: 'родитель@example.com' })).statusCode).toBe(201);
      const twice = await post('/api/admin/parents', { email: 'РОДИТЕЛЬ@example.com' });
      expect(twice.statusCode).toBe(409);
      expect(actions()).toEqual(['parent-create']);
    });
    it('на поломке управляющей базы отвечает пятисоткой и не оставляет семью без ссылки', async () => {
      // Родитель и его приглашение — одна транзакция: заведённый без ссылки
      // родитель входа не имеет вовсе, а второй раз по тому же адресу его уже
      // не завести — `UNIQUE` отдаст 409 навсегда.
      control.exec('DROP TABLE parent_invites');

      const broken = await post('/api/admin/parents', { email: 'родитель@example.com' });

      expect(broken.statusCode).toBe(500);
      expect(findParentByEmail(control, 'родитель@example.com')).toBeUndefined();
      expect(actions()).toEqual([]);
    });
  });

  describe('ссылка на смену пароля', () => {
    it('выпускает ссылку живому родителю и гасит ею прежнюю', async () => {
      const parent = parentWithPassword();

      const first = await post(`/api/admin/parents/${parent.parentId}/invite`, {});
      expect(first.statusCode).toBe(201);
      const firstToken = (first.json() as { invite: { path: string } }).invite.path.replace('/invite/', '');
      const second = await post(`/api/admin/parents/${parent.parentId}/invite`, {});
      const secondToken = (second.json() as { invite: { path: string } }).invite.path.replace('/invite/', '');

      // Обе ссылки живы: гасит их не выпуск соседней, а первая установка
      // пароля — она двигает `credentials_changed_at`.
      expect(readParentInvite(control, firstToken, NOW).ok).toBe(true);
      const redeemed = redeemParentInvite(control, secondToken, 'совсем-другой-пароль', NOW);
      expect(redeemed.ok).toBe(true);
      expect(readParentInvite(control, firstToken, NOW)).toEqual({ ok: false, reason: 'expired' });
      expect(actions()).toEqual(['parent-invite', 'parent-invite']);
    });

    it('не выпускает ссылку отключённому и незаведённому родителю', async () => {
      const parent = parentWithPassword();
      disableParent(control, parent.parentId, NOW);

      expect((await post(`/api/admin/parents/${parent.parentId}/invite`, {})).statusCode).toBe(409);
      expect((await post('/api/admin/parents/нет-такого/invite', {})).statusCode).toBe(404);
      expect(actions()).toEqual([]);
    });
  });

  describe('пароль, поставленный оператором', () => {
    it('ставит пароль, гасит сессии родителя и устройства его детей', async () => {
      const parent = parentWithPassword();
      const childId = createChild(control, parent.parentId, 'Ученик', NOW);
      markChildReady(control, childId);
      const deviceInvite = issueDeviceInvite(control, childId, 'browser', 'Компьютер', NOW);
      expect(redeemDeviceInvite(control, deviceInvite.token, NOW).ok).toBe(true);

      const response = await post(
        `/api/admin/parents/${parent.parentId}/password`,
        { password: 'совсем-другой-пароль' },
      );

      expect(response.statusCode).toBe(200);
      // Пароль в ответе не возвращается: оператор его и так прислал, а ответ
      // уезжает в журнал прокси и в историю вкладки.
      expect(JSON.stringify(response.json())).not.toContain('совсем-другой-пароль');
      expect(resolveParentSession(control, parent.token, NOW)).toBeUndefined();
      expect(listDevices(control, childId)[0]?.revokedAt).toBe(NOW.toISOString());
      expect(loginParent(control, 'родитель@example.com', PARENT_PASSWORD, NOW).ok).toBe(false);
      expect(loginParent(control, 'родитель@example.com', 'совсем-другой-пароль', NOW).ok).toBe(true);
      expect(actions()).toEqual(['parent-password']);
    });

    it('называет короткий и слишком длинный пароль, ничего не меняя', async () => {
      const parent = parentWithPassword();

      const short = await post(
        `/api/admin/parents/${parent.parentId}/password`,
        { password: 'к'.repeat(MIN_PASSWORD_LENGTH - 1) },
      );
      expect(short.statusCode).toBe(400);
      expect(String((short.json() as { error: string }).error)).toContain(String(MIN_PASSWORD_LENGTH));
      const long = await post(
        `/api/admin/parents/${parent.parentId}/password`,
        { password: 'к'.repeat(MAX_SECRET_LENGTH + 1) },
      );
      expect(long.statusCode).toBe(400);

      expect(resolveParentSession(control, parent.token, NOW)?.parentId).toBe(parent.parentId);
      expect(actions()).toEqual([]);
    });

    it('не ставит пароль отключённому и незаведённому родителю', async () => {
      const parent = parentWithPassword();
      disableParent(control, parent.parentId, NOW);

      expect((await post(`/api/admin/parents/${parent.parentId}/password`, { password: 'совсем-другой-пароль' })).statusCode)
        .toBe(409);
      expect((await post('/api/admin/parents/нет-такого/password', { password: 'совсем-другой-пароль' })).statusCode)
        .toBe(404);
      expect(actions()).toEqual([]);
    });
  });

  describe('допуск', () => {
    it('пускает только оператора и только со своей страницы', async () => {
      const parent = parentWithPassword();
      const routes: [string, object][] = [
        ['/api/admin/parents', { email: 'новый@example.com' }],
        [`/api/admin/parents/${parent.parentId}/invite`, {}],
        [`/api/admin/parents/${parent.parentId}/password`, { password: 'совсем-другой-пароль' }],
      ];

      for (const [url, payload] of routes) {
        // Родительская cookie на админском маршруте — не предъявитель: аренды у
        // него нет вовсе, и `createAdminContext` смотрит только свою cookie.
        expect((await post(url, payload, `${PARENT_COOKIE}=${parent.token}`)).statusCode).toBe(401);
        const foreign = await app.inject({ method: 'POST', url, headers: { cookie: adminCookie }, payload });
        expect(foreign.statusCode).toBe(403);
      }
      expect(actions()).toEqual([]);
      expect(loginParent(control, 'родитель@example.com', PARENT_PASSWORD, NOW).ok).toBe(true);
    });
  });

  describe('заглушка без управляющей базы', () => {
    it('отвечает 503 на все три маршрута', async () => {
      const stub = Fastify();
      registerUnavailableAdminParents(stub, 'управляющая база не открылась');
      await stub.ready();

      for (const url of [
        '/api/admin/parents',
        '/api/admin/parents/кто-то/invite',
        '/api/admin/parents/кто-то/password',
      ]) {
        const response = await stub.inject({ method: 'POST', url, headers: SAME_ORIGIN, payload: {} });
        expect(response.statusCode).toBe(503);
        expect(String((response.json() as { error: string }).error)).toContain('управляющая база не открылась');
      }
      await stub.close();
    });
  });
});
